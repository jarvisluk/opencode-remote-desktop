use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use apple_cf::cm::CMTime;
use apple_cf::iosurface::IOSurface;
use base64::Engine;
use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use screencapturekit::cm::CMSampleBufferExt;
use screencapturekit::prelude::*;
use screencapturekit::screenshot_manager::{CGImageExt, SCScreenshotManager};
use tokio::sync::mpsc;
use videotoolbox::compression::{CompressionSession, FrameProperties, ProfileLevel};
use videotoolbox::session::Codec;

use crate::browser::{discover_browser, resolve_binary};
use crate::h264::{avcc_to_annexb, fit_within_max_dim};
use crate::protocol::{
    CaptureResult, CaptureTargetKind, DisplayInfo, HostStatus, RemoteInputEvent, WindowInfo,
};

use super::VideoFrame;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> u8;
}

#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: *const c_void,
        assertion_level: u32,
        assertion_name: *const c_void,
        assertion_id: *mut u32,
    ) -> i32;
    fn IOPMAssertionRelease(assertion_id: u32) -> i32;
}

const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

static KEEP_AWAKE_ID: AtomicU32 = AtomicU32::new(0);
static LAST_CONTENT: Mutex<Option<(Instant, SCShareableContent)>> = Mutex::new(None);
static CLICK_STATE: Mutex<ClickTracker> = Mutex::new(ClickTracker {
    last_time_ms: 0,
    last_x: 0.0,
    last_y: 0.0,
    last_button: 0,
    count: 0,
});

struct ClickTracker {
    last_time_ms: u64,
    last_x: f64,
    last_y: f64,
    last_button: u8,
    count: i64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn get_shareable_content(fresh: bool) -> Result<SCShareableContent> {
    if !fresh {
        if let Ok(guard) = LAST_CONTENT.lock() {
            if let Some((ts, ref cached)) = *guard {
                if ts.elapsed() < Duration::from_millis(1500) {
                    return Ok(cached.clone());
                }
            }
        }
    }
    let content = SCShareableContent::get().map_err(|e| anyhow!("SCShareableContent: {e}"))?;
    if let Ok(mut guard) = LAST_CONTENT.lock() {
        *guard = Some((Instant::now(), content.clone()));
    }
    Ok(content)
}

pub fn host_status() -> HostStatus {
    let browser = discover_browser();
    let accessibility = if unsafe { AXIsProcessTrusted() } != 0 {
        "granted"
    } else {
        "denied"
    };
    let screen_recording = if unsafe { CGPreflightScreenCaptureAccess() } != 0 {
        "granted"
    } else {
        "denied"
    };
    let displays = list_displays().unwrap_or_default();

    HostStatus {
        platform: "darwin".to_string(),
        arch: std::env::consts::ARCH.to_string(),
        supported: true,
        accessibility: accessibility.to_string(),
        screen_recording: screen_recording.to_string(),
        backend: "screencapturekit".to_string(),
        stream_backend: "videotoolbox".to_string(),
        agent_desktop_bin: resolve_binary("agent-desktop"),
        agent_browser_bin: browser.agent_browser_bin,
        displays,
        keep_awake: is_keep_awake(),
        note: None,
    }
}

pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let main_id = CGDisplay::main().id;
    let ids = CGDisplay::active_displays().map_err(|e| anyhow!("CGDisplay error {e}"))?;
    let mut out = Vec::with_capacity(ids.len());
    for (idx, id) in ids.into_iter().enumerate() {
        let disp = CGDisplay::new(id);
        let bounds = disp.bounds();
        out.push(DisplayInfo {
            id: format!("{id}"),
            name: if id == main_id {
                format!("Display {} (Primary)", idx + 1)
            } else {
                format!("Display {}", idx + 1)
            },
            width: bounds.size.width as u32,
            height: bounds.size.height as u32,
            x: bounds.origin.x as i32,
            y: bounds.origin.y as i32,
            is_primary: id == main_id,
        });
    }
    out.sort_by_key(|d| !d.is_primary);
    Ok(out)
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let content = get_shareable_content(true)?;
    let displays = content.displays();
    let mut out = Vec::new();
    let my_pid = std::process::id() as i32;

    for w in content.windows() {
        if !w.is_on_screen() || w.window_layer() != 0 {
            continue;
        }
        let frame = w.frame();
        if frame.size.width < 40.0 || frame.size.height < 40.0 {
            continue;
        }
        let (app, pid) = match w.owning_application() {
            Some(a) => (a.application_name(), a.process_id()),
            None => (String::new(), 0),
        };
        if pid == my_pid {
            continue;
        }
        let title = w.title().unwrap_or_default();
        if app.is_empty() && title.is_empty() {
            continue;
        }
        let cx = frame.origin.x + frame.size.width / 2.0;
        let cy = frame.origin.y + frame.size.height / 2.0;
        let display_id = displays
            .iter()
            .find(|d| {
                let df = d.frame();
                cx >= df.origin.x
                    && cx <= df.origin.x + df.size.width
                    && cy >= df.origin.y
                    && cy <= df.origin.y + df.size.height
            })
            .map(|d| d.display_id().to_string());

        out.push(WindowInfo {
            id: format!("w-{}", w.window_id()),
            app,
            title,
            x: frame.origin.x as i32,
            y: frame.origin.y as i32,
            width: frame.size.width as u32,
            height: frame.size.height as u32,
            display_id,
            focused: w.is_active(),
        });
    }
    Ok(out)
}

fn resolve_target_filter(
    content: &SCShareableContent,
    target: &CaptureTargetKind,
) -> Result<(SCContentFilter, u32, u32, i32, i32, f32, String)> {
    match target {
        CaptureTargetKind::Window(wid) => {
            let win = content
                .windows()
                .into_iter()
                .find(|w| w.window_id() == *wid)
                .ok_or_else(|| anyhow!("Window w-{wid} not found"))?;
            let frame = win.frame();
            let filter = SCContentFilter::create()
                .with_window(&win)
                .build()
                .map_err(|e| anyhow!("SCContentFilter window build: {e}"))?;
            let scale = filter.point_pixel_scale().max(1.0);
            let lw = (frame.size.width.round() as u32).max(2);
            let lh = (frame.size.height.round() as u32).max(2);
            Ok((
                filter,
                lw,
                lh,
                frame.origin.x.round() as i32,
                frame.origin.y.round() as i32,
                scale,
                format!("w-{wid}"),
            ))
        }
        CaptureTargetKind::Screen(idx) => {
            let mut displays = content.displays();
            if displays.is_empty() {
                return Err(anyhow!("No displays found"));
            }
            let main_id = CGDisplay::main().id;
            displays.sort_by_key(|d| if d.display_id() == main_id { 0 } else { 1 });
            let picked = displays
                .get(*idx as usize)
                .or_else(|| displays.iter().find(|d| d.display_id() == *idx))
                .unwrap_or(&displays[0]);
            let frame = picked.frame();
            let filter = SCContentFilter::create()
                .with_display(picked)
                .with_excluding_windows(&[])
                .build()
                .map_err(|e| anyhow!("SCContentFilter display build: {e}"))?;
            let scale = filter.point_pixel_scale().max(1.0);
            let lw = (frame.size.width.round() as u32).max(2);
            let lh = (frame.size.height.round() as u32).max(2);
            Ok((
                filter,
                lw,
                lh,
                frame.origin.x.round() as i32,
                frame.origin.y.round() as i32,
                scale,
                format!("screen:{idx}"),
            ))
        }
    }
}

pub fn capture_jpeg(
    target: CaptureTargetKind,
    max_dim: u32,
    quality: u8,
) -> Result<CaptureResult> {
    let content = get_shareable_content(false)?;
    let (filter, lw, lh, ox, oy, scale, target_label) =
        resolve_target_filter(&content, &target).or_else(|_| {
            let fresh = get_shareable_content(true)?;
            resolve_target_filter(&fresh, &target)
        })?;

    let native_w = ((lw as f32) * scale).round() as u32;
    let native_h = ((lh as f32) * scale).round() as u32;
    let (out_w, out_h) = fit_within_max_dim(native_w.max(2), native_h.max(2), max_dim);

    let config = SCStreamConfiguration::new()
        .with_width(out_w)
        .with_height(out_h)
        .with_shows_cursor(true);

    let image = SCScreenshotManager::capture_image(&filter, &config)
        .map_err(|e| anyhow!("SCScreenshotManager failed: {e}"))?;
    let img_w = image.width() as u32;
    let img_h = image.height() as u32;
    let rgba = image
        .rgba_data()
        .map_err(|e| anyhow!("CGImage rgba_data failed: {e}"))?;

    let mut jpeg = Vec::with_capacity((img_w * img_h / 4) as usize);
    let encoder = jpeg_encoder::Encoder::new(&mut jpeg, quality.clamp(20, 95));
    encoder.encode(
        &rgba,
        img_w as u16,
        img_h as u16,
        jpeg_encoder::ColorType::Rgba,
    )?;

    Ok(CaptureResult {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg),
        mime: "image/jpeg".to_string(),
        width: img_w,
        height: img_h,
        logical_width: lw,
        logical_height: lh,
        logical_origin_x: ox,
        logical_origin_y: oy,
        scale: (img_w as f64) / (lw.max(1) as f64),
        target: target_label,
        backend: "screencapturekit".to_string(),
    })
}

struct StreamState {
    stream: SCStream,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    force_keyframe: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    wakeup_tx: std::sync::mpsc::SyncSender<()>,
}

pub struct VideoStreamHandle {
    inner: Arc<Mutex<StreamState>>,
}

impl VideoStreamHandle {
    pub fn request_keyframe(&self) {
        if let Ok(guard) = self.inner.lock() {
            guard.force_keyframe.store(true, Ordering::SeqCst);
            let _ = guard.wakeup_tx.try_send(());
        }
    }

    pub fn retarget(
        &self,
        target: CaptureTargetKind,
        fps: u32,
        max_dim: u32,
        bitrate: u32,
    ) -> Result<()> {
        let content = get_shareable_content(true)?;
        let (filter, lw, lh, _ox, _oy, scale, _label) = resolve_target_filter(&content, &target)?;
        let native_w = ((lw as f32) * scale).round() as u32;
        let native_h = ((lh as f32) * scale).round() as u32;
        let (out_w, out_h) = fit_within_max_dim(native_w.max(2), native_h.max(2), max_dim);

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("stream lock poisoned"))?;
        let config = SCStreamConfiguration::new()
            .with_width(out_w)
            .with_height(out_h)
            .with_pixel_format(PixelFormat::BGRA)
            .with_shows_cursor(true)
            .with_queue_depth(3)
            .with_minimum_frame_interval(&screencapturekit::cm::CMTime::new(
                1,
                fps.clamp(1, 60) as i32,
            ));

        guard
            .stream
            .update_content_filter(&filter)
            .map_err(|e| anyhow!("update_content_filter: {e}"))?;
        guard
            .stream
            .update_configuration(&config)
            .map_err(|e| anyhow!("update_configuration: {e}"))?;
        guard.width = out_w;
        guard.height = out_h;
        guard.fps = fps;
        guard.bitrate = bitrate;
        guard.force_keyframe.store(true, Ordering::SeqCst);
        let _ = guard.wakeup_tx.try_send(());
        Ok(())
    }
}

impl Drop for VideoStreamHandle {
    fn drop(&mut self) {
        if let Ok(guard) = self.inner.lock() {
            guard.stopped.store(true, Ordering::SeqCst);
            let _ = guard.wakeup_tx.try_send(());
            let _ = guard.stream.stop_capture();
        }
    }
}

struct CaptureHandler {
    latest_surface: Arc<Mutex<Option<(IOSurface, u64)>>>,
    wakeup_tx: std::sync::mpsc::SyncSender<()>,
    start_instant: Instant,
}

impl SCStreamOutputTrait for CaptureHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
        if !matches!(output_type, SCStreamOutputType::Screen) {
            return;
        }
        let Some(pb) = sample.pixel_buffer() else {
            return;
        };
        if !pb.is_backed_by_io_surface() {
            return;
        }
        let Some(surface) = pb.io_surface() else {
            return;
        };
        let pts_us = self.start_instant.elapsed().as_micros() as u64;
        if let Ok(mut slot) = self.latest_surface.lock() {
            *slot = Some((surface, pts_us));
        }
        let _ = self.wakeup_tx.try_send(());
    }
}

fn build_vt_encoder(w: u32, h: u32, fps: u32, bitrate: u32) -> Result<CompressionSession> {
    CompressionSession::builder(w as i32, h as i32, Codec::H264)
        .with_real_time(true)
        .with_allow_frame_reordering(false)
        .with_profile_level(ProfileLevel::H264ConstrainedBaselineAutoLevel)
        .with_average_bit_rate(bitrate.clamp(300_000, 12_000_000) as i32)
        .with_expected_frame_rate(fps.clamp(1, 60) as f64)
        .with_max_keyframe_interval((fps.clamp(1, 60) * 2) as i32)
        .with_low_latency_rate_control(true)
        .build()
        .or_else(|_| {
            CompressionSession::builder(w as i32, h as i32, Codec::H264)
                .with_real_time(true)
                .with_allow_frame_reordering(false)
                .with_profile_level(ProfileLevel::H264ConstrainedBaselineAutoLevel)
                .with_average_bit_rate(bitrate.clamp(300_000, 12_000_000) as i32)
                .with_expected_frame_rate(fps.clamp(1, 60) as f64)
                .with_max_keyframe_interval((fps.clamp(1, 60) * 2) as i32)
                .build()
        })
        .map_err(|e| anyhow!("VideoToolbox CompressionSession build failed: {e}"))
}

fn extract_h264_param_sets(sample_buf: *mut c_void) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let mut sps = Vec::new();
    let mut pps = Vec::new();
    if sample_buf.is_null() {
        return (sps, pps);
    }
    unsafe {
        let fmt = apple_cf::raw::CMSampleBufferGetFormatDescription(sample_buf.cast());
        if fmt.is_null() {
            return (sps, pps);
        }
        let mut count = 0usize;
        let status = apple_cf::raw::CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fmt,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut count,
            std::ptr::null_mut(),
        );
        if status != 0 || count == 0 {
            return (sps, pps);
        }
        for idx in 0..count {
            let mut ptr: *const u8 = std::ptr::null();
            let mut size = 0usize;
            let st = apple_cf::raw::CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt,
                idx,
                &mut ptr,
                &mut size,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if st == 0 && !ptr.is_null() && size > 0 {
                let slice = std::slice::from_raw_parts(ptr, size).to_vec();
                let nalu_type = slice[0] & 0x1F;
                if nalu_type == 7 {
                    sps.push(slice);
                } else if nalu_type == 8 {
                    pps.push(slice);
                }
            }
        }
    }
    (sps, pps)
}

pub fn start_video_stream(
    target: CaptureTargetKind,
    fps: u32,
    max_dim: u32,
    bitrate: u32,
    tx: mpsc::Sender<VideoFrame>,
) -> Result<VideoStreamHandle> {
    let content = get_shareable_content(true)?;
    let (filter, lw, lh, _ox, _oy, scale, _label) = resolve_target_filter(&content, &target)?;
    let native_w = ((lw as f32) * scale).round() as u32;
    let native_h = ((lh as f32) * scale).round() as u32;
    let (out_w, out_h) = fit_within_max_dim(native_w.max(2), native_h.max(2), max_dim);

    let config = SCStreamConfiguration::new()
        .with_width(out_w)
        .with_height(out_h)
        .with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(true)
        .with_queue_depth(3)
        .with_minimum_frame_interval(&screencapturekit::cm::CMTime::new(
            1,
            fps.clamp(1, 60) as i32,
        ));

    let latest_surface: Arc<Mutex<Option<(IOSurface, u64)>>> = Arc::new(Mutex::new(None));
    let (wakeup_tx, wakeup_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let stopped = Arc::new(AtomicBool::new(false));
    let force_keyframe = Arc::new(AtomicBool::new(true));

    let handler = CaptureHandler {
        latest_surface: latest_surface.clone(),
        wakeup_tx: wakeup_tx.clone(),
        start_instant: Instant::now(),
    };

    let mut stream =
        SCStream::new(&filter, &config).map_err(|e| anyhow!("SCStream::new failed: {e}"))?;
    stream
        .add_output_handler(handler, SCStreamOutputType::Screen)
        .map_err(|e| anyhow!("SCStream::add_output_handler failed: {e}"))?;
    stream
        .start_capture()
        .map_err(|e| anyhow!("SCStream::start_capture failed: {e}"))?;

    let state = Arc::new(Mutex::new(StreamState {
        stream,
        width: out_w,
        height: out_h,
        fps,
        bitrate,
        force_keyframe: force_keyframe.clone(),
        stopped: stopped.clone(),
        wakeup_tx,
    }));

    let state_clone = state.clone();
    std::thread::Builder::new()
        .name("bot-vt-encoder".to_string())
        .spawn(move || {
            let mut cur_w = out_w;
            let mut cur_h = out_h;
            let mut cur_fps = fps;
            let mut cur_bitrate = bitrate;
            let mut encoder = match build_vt_encoder(cur_w, cur_h, cur_fps, cur_bitrate) {
                Ok(e) => e,
                Err(err) => {
                    tracing::error!("VideoToolbox init error: {err}");
                    return;
                }
            };
            let mut last_surface: Option<IOSurface> = None;
            let mut last_pts_us = 0u64;
            let start = Instant::now();

            loop {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let _ = wakeup_rx.recv_timeout(Duration::from_millis(250));
                if stopped.load(Ordering::SeqCst) {
                    break;
                }

                if let Ok(guard) = state_clone.lock() {
                    if guard.width != cur_w
                        || guard.height != cur_h
                        || guard.fps != cur_fps
                        || guard.bitrate != cur_bitrate
                    {
                        cur_w = guard.width;
                        cur_h = guard.height;
                        cur_fps = guard.fps;
                        cur_bitrate = guard.bitrate;
                        if let Ok(new_enc) = build_vt_encoder(cur_w, cur_h, cur_fps, cur_bitrate) {
                            encoder = new_enc;
                            force_keyframe.store(true, Ordering::SeqCst);
                        }
                    }
                }

                let popped = latest_surface
                    .lock()
                    .ok()
                    .and_then(|mut g| g.take());
                let force_key = force_keyframe.swap(false, Ordering::SeqCst);

                let (surface, pts_us) = match popped {
                    Some((surf, pts)) => {
                        last_surface = Some(surf.clone());
                        last_pts_us = pts;
                        (surf, pts)
                    }
                    None if force_key => {
                        if let Some(ref surf) = last_surface {
                            let pts = start.elapsed().as_micros() as u64;
                            last_pts_us = pts.max(last_pts_us + 1000);
                            (surf.clone(), last_pts_us)
                        } else {
                            continue;
                        }
                    }
                    None => continue,
                };

                let props = FrameProperties::new().with_force_key_frame(force_key);
                let cm_pts = CMTime::new(pts_us as i64, 1_000_000);
                let encoded = match encoder.encode_with_properties(&surface, cm_pts, props) {
                    Ok(f) => f,
                    Err(err) => {
                        tracing::debug!("VT encode frame error: {err}");
                        continue;
                    }
                };
                if encoded.data.is_empty() {
                    continue;
                }
                let (sps, pps) = extract_h264_param_sets(encoded.cm_sample_buffer_ptr().cast());
                let (annexb, is_keyframe) =
                    avcc_to_annexb(&encoded.data, &sps, &pps, force_key);
                if annexb.is_empty() {
                    continue;
                }
                if tx
                    .blocking_send(VideoFrame {
                        annexb,
                        pts_us,
                        is_keyframe,
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .context("failed to spawn VideoToolbox encoder thread")?;

    Ok(VideoStreamHandle { inner: state })
}

pub fn inject_input(ev: &RemoteInputEvent) -> Result<()> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow!("CGEventSource creation failed"))?;

    match ev.kind.as_str() {
        "move" => {
            let pt = CGPoint::new(ev.x.unwrap_or(0.0), ev.y.unwrap_or(0.0));
            let event = CGEvent::new_mouse_event(
                source,
                CGEventType::MouseMoved,
                pt,
                CGMouseButton::Left,
            )
            .map_err(|_| anyhow!("CGEvent mouse move failed"))?;
            event.post(CGEventTapLocation::HID);
        }
        "down" | "up" => {
            let is_down = ev.kind == "down";
            let pt = CGPoint::new(ev.x.unwrap_or(0.0), ev.y.unwrap_or(0.0));
            let button = ev.button.as_deref().unwrap_or("left");
            let (cg_btn, btn_num, ev_type) = match button {
                "right" => (
                    CGMouseButton::Right,
                    2u8,
                    if is_down {
                        CGEventType::RightMouseDown
                    } else {
                        CGEventType::RightMouseUp
                    },
                ),
                "middle" => (
                    CGMouseButton::Center,
                    3u8,
                    if is_down {
                        CGEventType::OtherMouseDown
                    } else {
                        CGEventType::OtherMouseUp
                    },
                ),
                _ => (
                    CGMouseButton::Left,
                    1u8,
                    if is_down {
                        CGEventType::LeftMouseDown
                    } else {
                        CGEventType::LeftMouseUp
                    },
                ),
            };

            let click_count = if let Ok(mut tracker) = CLICK_STATE.lock() {
                if is_down {
                    let t = now_ms();
                    let dist = (pt.x - tracker.last_x).abs() + (pt.y - tracker.last_y).abs();
                    if tracker.last_button == btn_num
                        && t.saturating_sub(tracker.last_time_ms) <= 450
                        && dist <= 5.0
                    {
                        tracker.count += 1;
                    } else {
                        tracker.count = 1;
                    }
                    tracker.last_time_ms = t;
                    tracker.last_x = pt.x;
                    tracker.last_y = pt.y;
                    tracker.last_button = btn_num;
                }
                tracker.count.max(1)
            } else {
                1
            };

            let event = CGEvent::new_mouse_event(source, ev_type, pt, cg_btn)
                .map_err(|_| anyhow!("CGEvent mouse click failed"))?;
            event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_count);
            event.post(CGEventTapLocation::HID);
        }
        "wheel" => {
            let dy = -(ev.dy.unwrap_or(0.0).round() as i32);
            let dx = -(ev.dx.unwrap_or(0.0).round() as i32);
            let event = CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, dy, dx, 0)
                .map_err(|_| anyhow!("CGEvent scroll failed"))?;
            event.post(CGEventTapLocation::HID);
        }
        "keydown" | "keyup" => {
            let is_down = ev.kind == "keydown";
            let key_code = map_web_key_to_macos_keycode(ev.code.as_deref(), ev.key.as_deref())
                .ok_or_else(|| {
                    anyhow!(
                        "Unmapped key code={:?} key={:?}",
                        ev.code,
                        ev.key
                    )
                })?;
            let event = CGEvent::new_keyboard_event(source, key_code, is_down)
                .map_err(|_| anyhow!("CGEvent keyboard failed"))?;
            let mut flags = CGEventFlags::empty();
            if ev.shift.unwrap_or(false) {
                flags |= CGEventFlags::CGEventFlagShift;
            }
            if ev.ctrl.unwrap_or(false) {
                flags |= CGEventFlags::CGEventFlagControl;
            }
            if ev.alt.unwrap_or(false) {
                flags |= CGEventFlags::CGEventFlagAlternate;
            }
            if ev.meta.unwrap_or(false) {
                flags |= CGEventFlags::CGEventFlagCommand;
            }
            event.set_flags(flags);
            event.post(CGEventTapLocation::HID);
        }
        "text" => {
            if let Some(text) = ev.text.as_deref() {
                inject_text(text)?;
            }
        }
        other => return Err(anyhow!("Unknown input event type: {other}")),
    }

    Ok(())
}

pub fn inject_text(text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow!("CGEventSource creation failed"))?;
    let utf16: Vec<u16> = text.encode_utf16().collect();
    for chunk in utf16.chunks(16) {
        let down = CGEvent::new_keyboard_event(source.clone(), 0, true)
            .map_err(|_| anyhow!("CGEvent unicode down failed"))?;
        down.set_string_from_utf16_unchecked(chunk);
        down.post(CGEventTapLocation::HID);

        let up = CGEvent::new_keyboard_event(source.clone(), 0, false)
            .map_err(|_| anyhow!("CGEvent unicode up failed"))?;
        up.set_string_from_utf16_unchecked(chunk);
        up.post(CGEventTapLocation::HID);
    }
    Ok(())
}

pub fn set_keep_awake(enabled: bool) -> Result<bool> {
    if enabled {
        if KEEP_AWAKE_ID.load(Ordering::SeqCst) != 0 {
            return Ok(true);
        }
        let kind = CFString::new("PreventUserIdleDisplaySleep");
        let reason = CFString::new("opencode-remote-desktop active session");
        let mut assertion_id: u32 = 0;
        let rc = unsafe {
            IOPMAssertionCreateWithName(
                kind.as_concrete_TypeRef().cast(),
                K_IOPM_ASSERTION_LEVEL_ON,
                reason.as_concrete_TypeRef().cast(),
                &mut assertion_id,
            )
        };
        if rc != 0 || assertion_id == 0 {
            return Err(anyhow!("IOPMAssertionCreateWithName failed: {rc}"));
        }
        KEEP_AWAKE_ID.store(assertion_id, Ordering::SeqCst);
        Ok(true)
    } else {
        let id = KEEP_AWAKE_ID.swap(0, Ordering::SeqCst);
        if id != 0 {
            unsafe {
                IOPMAssertionRelease(id);
            }
        }
        Ok(false)
    }
}

pub fn is_keep_awake() -> bool {
    KEEP_AWAKE_ID.load(Ordering::SeqCst) != 0
}

fn map_web_key_to_macos_keycode(code: Option<&str>, key: Option<&str>) -> Option<u16> {
    if let Some(c) = code {
        let kc = match c {
            "KeyA" => Some(0x00),
            "KeyS" => Some(0x01),
            "KeyD" => Some(0x02),
            "KeyF" => Some(0x03),
            "KeyH" => Some(0x04),
            "KeyG" => Some(0x05),
            "KeyZ" => Some(0x06),
            "KeyX" => Some(0x07),
            "KeyC" => Some(0x08),
            "KeyV" => Some(0x09),
            "KeyB" => Some(0x0B),
            "KeyQ" => Some(0x0C),
            "KeyW" => Some(0x0D),
            "KeyE" => Some(0x0E),
            "KeyR" => Some(0x0F),
            "KeyY" => Some(0x10),
            "KeyT" => Some(0x11),
            "Digit1" => Some(0x12),
            "Digit2" => Some(0x13),
            "Digit3" => Some(0x14),
            "Digit4" => Some(0x15),
            "Digit6" => Some(0x16),
            "Digit5" => Some(0x17),
            "Equal" => Some(0x18),
            "Digit9" => Some(0x19),
            "Digit7" => Some(0x1A),
            "Minus" => Some(0x1B),
            "Digit8" => Some(0x1C),
            "Digit0" => Some(0x1D),
            "BracketRight" => Some(0x1E),
            "KeyO" => Some(0x1F),
            "KeyU" => Some(0x20),
            "BracketLeft" => Some(0x21),
            "KeyI" => Some(0x22),
            "KeyP" => Some(0x23),
            "Enter" | "NumpadEnter" => Some(0x24),
            "KeyL" => Some(0x25),
            "KeyJ" => Some(0x26),
            "Quote" => Some(0x27),
            "KeyK" => Some(0x28),
            "Semicolon" => Some(0x29),
            "Backslash" => Some(0x2A),
            "Comma" => Some(0x2B),
            "Slash" => Some(0x2C),
            "KeyN" => Some(0x2D),
            "KeyM" => Some(0x2E),
            "Period" => Some(0x2F),
            "Tab" => Some(0x30),
            "Space" => Some(0x31),
            "Backquote" => Some(0x32),
            "Backspace" => Some(0x33),
            "Escape" => Some(0x35),
            "MetaRight" => Some(0x36),
            "MetaLeft" => Some(0x37),
            "ShiftLeft" => Some(0x38),
            "CapsLock" => Some(0x39),
            "AltLeft" => Some(0x3A),
            "ControlLeft" => Some(0x3B),
            "ShiftRight" => Some(0x3C),
            "AltRight" => Some(0x3D),
            "ControlRight" => Some(0x3E),
            "F1" => Some(0x7A),
            "F2" => Some(0x78),
            "F3" => Some(0x63),
            "F4" => Some(0x76),
            "F5" => Some(0x60),
            "F6" => Some(0x61),
            "F7" => Some(0x62),
            "F8" => Some(0x64),
            "F9" => Some(0x65),
            "F10" => Some(0x6D),
            "F11" => Some(0x67),
            "F12" => Some(0x6F),
            "Home" => Some(0x73),
            "PageUp" => Some(0x74),
            "Delete" => Some(0x75),
            "End" => Some(0x77),
            "PageDown" => Some(0x79),
            "ArrowLeft" => Some(0x7B),
            "ArrowRight" => Some(0x7C),
            "ArrowDown" => Some(0x7D),
            "ArrowUp" => Some(0x7E),
            _ => None,
        };
        if kc.is_some() {
            return kc;
        }
    }

    match key? {
        "Enter" => Some(0x24),
        "Tab" => Some(0x30),
        " " | "Spacebar" => Some(0x31),
        "Backspace" => Some(0x33),
        "Escape" | "Esc" => Some(0x35),
        "Delete" => Some(0x75),
        "ArrowLeft" => Some(0x7B),
        "ArrowRight" => Some(0x7C),
        "ArrowDown" => Some(0x7D),
        "ArrowUp" => Some(0x7E),
        "Home" => Some(0x73),
        "End" => Some(0x77),
        "PageUp" => Some(0x74),
        "PageDown" => Some(0x79),
        "Meta" => Some(0x37),
        "Shift" => Some(0x38),
        "Alt" => Some(0x3A),
        "Control" => Some(0x3B),
        s if s.len() == 1 => {
            let ch = s.chars().next()?.to_ascii_lowercase();
            match ch {
                'a' => Some(0x00),
                's' => Some(0x01),
                'd' => Some(0x02),
                'f' => Some(0x03),
                'h' => Some(0x04),
                'g' => Some(0x05),
                'z' => Some(0x06),
                'x' => Some(0x07),
                'c' => Some(0x08),
                'v' => Some(0x09),
                'b' => Some(0x0B),
                'q' => Some(0x0C),
                'w' => Some(0x0D),
                'e' => Some(0x0E),
                'r' => Some(0x0F),
                'y' => Some(0x10),
                't' => Some(0x11),
                '1' => Some(0x12),
                '2' => Some(0x13),
                '3' => Some(0x14),
                '4' => Some(0x15),
                '6' => Some(0x16),
                '5' => Some(0x17),
                '=' => Some(0x18),
                '9' => Some(0x19),
                '7' => Some(0x1A),
                '-' => Some(0x1B),
                '8' => Some(0x1C),
                '0' => Some(0x1D),
                ']' => Some(0x1E),
                'o' => Some(0x1F),
                'u' => Some(0x20),
                '[' => Some(0x21),
                'i' => Some(0x22),
                'p' => Some(0x23),
                'l' => Some(0x25),
                'j' => Some(0x26),
                '\'' => Some(0x27),
                'k' => Some(0x28),
                ';' => Some(0x29),
                '\\' => Some(0x2A),
                ',' => Some(0x2B),
                '/' => Some(0x2C),
                'n' => Some(0x2D),
                'm' => Some(0x2E),
                '.' => Some(0x2F),
                '`' => Some(0x32),
                _ => None,
            }
        }
        _ => None,
    }
}

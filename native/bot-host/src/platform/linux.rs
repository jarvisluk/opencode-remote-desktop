use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use openh264::encoder::{
    BitRate, Encoder, EncoderConfig, FrameRate, RateControlMode, SpsPpsStrategy, UsageType,
};
use openh264::formats::{BgraSliceU8, YUVBuffer};
use openh264::OpenH264API;
use tokio::sync::mpsc;
use x11rb::connection::Connection;
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{
    self, AtomEnum, ConnectionExt as _, ImageFormat, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT,
    KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

use crate::browser::{discover_browser, resolve_binary};
use crate::h264::{contains_idr_annexb, downscale_bgra, encode_jpeg_from_bgra, fit_within_max_dim};
use crate::protocol::{
    CaptureResult, CaptureTargetKind, DisplayInfo, HostStatus, RemoteInputEvent, WindowInfo,
};

use super::VideoFrame;

static KEEP_AWAKE_COOKIE: AtomicU32 = AtomicU32::new(0);
static KEEP_AWAKE_ACTIVE: AtomicBool = AtomicBool::new(false);

fn has_display() -> bool {
    std::env::var_os("DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn has_wayland() -> bool {
    std::env::var_os("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

pub fn host_status() -> HostStatus {
    let browser = discover_browser();
    let x11_ok = has_display() && RustConnection::connect(None).is_ok();
    let wayland_only = !x11_ok && has_wayland();
    let backend = if x11_ok {
        "x11"
    } else if wayland_only {
        "wayland-portal"
    } else {
        "headless"
    };
    let displays = list_displays().unwrap_or_default();

    HostStatus {
        platform: "linux".to_string(),
        arch: std::env::consts::ARCH.to_string(),
        supported: x11_ok || wayland_only,
        accessibility: if x11_ok || wayland_only {
            "granted".to_string()
        } else {
            "unavailable".to_string()
        },
        screen_recording: if x11_ok || wayland_only {
            "granted".to_string()
        } else {
            "unavailable".to_string()
        },
        backend: backend.to_string(),
        stream_backend: if x11_ok {
            "openh264".to_string()
        } else {
            "unsupported".to_string()
        },
        agent_desktop_bin: resolve_binary("agent-desktop"),
        agent_browser_bin: browser.agent_browser_bin,
        displays,
        keep_awake: is_keep_awake(),
        note: if !x11_ok && wayland_only {
            Some("Wayland session without DISPLAY; XWayland/X11 recommended for low-latency H.264 streaming".to_string())
        } else if !x11_ok {
            Some("No DISPLAY or WAYLAND_DISPLAY found".to_string())
        } else {
            None
        },
    }
}

fn connect_x11() -> Result<(RustConnection, usize, xproto::Screen)> {
    let (conn, screen_num) = RustConnection::connect(None)
        .map_err(|e| anyhow!("X11 connect failed (is DISPLAY set?): {e}"))?;
    let screen = conn
        .setup()
        .roots
        .get(screen_num)
        .cloned()
        .ok_or_else(|| anyhow!("X11 screen {screen_num} not found"))?;
    Ok((conn, screen_num, screen))
}

pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let (conn, _screen_num, screen) = connect_x11()?;
    let root = screen.root;
    let mut out = Vec::new();

    if let Ok(res_cookie) = conn.randr_get_screen_resources_current(root) {
        if let Ok(res) = res_cookie.reply() {
            for (idx, output) in res.outputs.iter().enumerate() {
                if let Some(info) = conn
                    .randr_get_output_info(*output, res.config_timestamp)
                    .ok()
                    .and_then(|c| c.reply().ok())
                {
                    if info.crtc == 0 || info.connection != randr::Connection::CONNECTED {
                        continue;
                    }
                    if let Some(crtc) = conn
                        .randr_get_crtc_info(info.crtc, res.config_timestamp)
                        .ok()
                        .and_then(|c| c.reply().ok())
                    {
                        if crtc.width == 0 || crtc.height == 0 {
                            continue;
                        }
                        let name = String::from_utf8_lossy(&info.name).to_string();
                        out.push(DisplayInfo {
                            id: format!("{idx}"),
                            name: if name.is_empty() {
                                format!("Display {}", idx + 1)
                            } else {
                                name
                            },
                            width: crtc.width as u32,
                            height: crtc.height as u32,
                            x: crtc.x as i32,
                            y: crtc.y as i32,
                            is_primary: out.is_empty(),
                        });
                    }
                }
            }
        }
    }

    if out.is_empty() {
        out.push(DisplayInfo {
            id: "0".to_string(),
            name: "Display 1 (Primary)".to_string(),
            width: screen.width_in_pixels as u32,
            height: screen.height_in_pixels as u32,
            x: 0,
            y: 0,
            is_primary: true,
        });
    }
    Ok(out)
}

fn intern_atom(conn: &RustConnection, name: &[u8]) -> Result<xproto::Atom> {
    Ok(conn.intern_atom(false, name)?.reply()?.atom)
}

fn get_string_prop(
    conn: &RustConnection,
    win: xproto::Window,
    prop: xproto::Atom,
) -> Option<String> {
    let reply = conn
        .get_property(false, win, prop, AtomEnum::ANY, 0, 1024)
        .ok()?
        .reply()
        .ok()?;
    if reply.value.is_empty() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&reply.value)
            .trim_end_matches('\0')
            .to_string(),
    )
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let (conn, _screen_num, screen) = connect_x11()?;
    let root = screen.root;
    let atom_client_list = intern_atom(&conn, b"_NET_CLIENT_LIST")?;
    let atom_wm_name = intern_atom(&conn, b"_NET_WM_NAME")?;
    let atom_active = intern_atom(&conn, b"_NET_ACTIVE_WINDOW")?;

    let active_win = conn
        .get_property(false, root, atom_active, AtomEnum::WINDOW, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().and_then(|mut it| it.next()))
        .unwrap_or(0);

    let list_reply = conn
        .get_property(false, root, atom_client_list, AtomEnum::WINDOW, 0, 4096)?
        .reply()?;

    let mut out = Vec::new();
    let Some(ids) = list_reply.value32() else {
        return Ok(out);
    };
    for win in ids {
        let Some(geom) = conn.get_geometry(win).ok().and_then(|c| c.reply().ok()) else {
            continue;
        };
        if geom.width < 40 || geom.height < 40 {
            continue;
        }
        let coords = conn
            .translate_coordinates(win, root, 0, 0)
            .ok()
            .and_then(|c| c.reply().ok());
        let (x, y) = coords
            .map(|c| (c.dst_x as i32, c.dst_y as i32))
            .unwrap_or((geom.x as i32, geom.y as i32));
        let title = get_string_prop(&conn, win, atom_wm_name)
            .or_else(|| get_string_prop(&conn, win, AtomEnum::WM_NAME.into()))
            .unwrap_or_default();
        let app = get_string_prop(&conn, win, AtomEnum::WM_CLASS.into())
            .and_then(|s| s.split('\0').last().map(ToOwned::to_owned))
            .unwrap_or_default();
        if title.is_empty() && app.is_empty() {
            continue;
        }
        out.push(WindowInfo {
            id: format!("w-{win}"),
            app,
            title,
            x,
            y,
            width: geom.width as u32,
            height: geom.height as u32,
            display_id: None,
            focused: win == active_win,
        });
    }
    Ok(out)
}

fn resolve_target_x11(
    conn: &RustConnection,
    screen: &xproto::Screen,
    target: &CaptureTargetKind,
) -> Result<(xproto::Drawable, i32, i32, u32, u32, String)> {
    match target {
        CaptureTargetKind::Window(wid) => {
            let win = *wid as xproto::Window;
            let geom = conn
                .get_geometry(win)?
                .reply()
                .map_err(|e| anyhow!("Window w-{wid} not found: {e}"))?;
            let coords = conn.translate_coordinates(win, screen.root, 0, 0)?.reply()?;
            Ok((
                win,
                coords.dst_x as i32,
                coords.dst_y as i32,
                (geom.width as u32).max(2),
                (geom.height as u32).max(2),
                format!("w-{wid}"),
            ))
        }
        CaptureTargetKind::Screen(idx) => {
            let displays = list_displays()?;
            let d = displays
                .get(*idx as usize)
                .or_else(|| displays.first())
                .ok_or_else(|| anyhow!("No displays found"))?;
            Ok((
                screen.root,
                d.x,
                d.y,
                d.width.max(2),
                d.height.max(2),
                format!("screen:{idx}"),
            ))
        }
    }
}

fn capture_x11_bgra(
    conn: &RustConnection,
    drawable: xproto::Drawable,
    x: i16,
    y: i16,
    w: u16,
    h: u16,
) -> Result<Vec<u8>> {
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, drawable, x, y, w, h, u32::MAX)?
        .reply()?;
    let expected = (w as usize) * (h as usize) * 4;
    if reply.data.len() < expected {
        return Err(anyhow!(
            "X11 get_image returned {} bytes, expected at least {expected} (depth={})",
            reply.data.len(),
            reply.depth
        ));
    }
    Ok(reply.data[..expected].to_vec())
}

pub fn capture_jpeg(
    target: CaptureTargetKind,
    max_dim: u32,
    quality: u8,
) -> Result<CaptureResult> {
    let (conn, _screen_num, screen) = connect_x11()?;
    let (drawable, ox, oy, lw, lh, label) = resolve_target_x11(&conn, &screen, &target)?;
    let (req_x, req_y) = match target {
        CaptureTargetKind::Window(_) => (0i16, 0i16),
        CaptureTargetKind::Screen(_) => (ox as i16, oy as i16),
    };
    let raw = capture_x11_bgra(&conn, drawable, req_x, req_y, lw as u16, lh as u16)?;
    let (out_w, out_h) = fit_within_max_dim(lw, lh, max_dim);
    let scaled = downscale_bgra(&raw, lw as usize, lh as usize, (lw as usize) * 4, out_w as usize, out_h as usize);
    let jpeg = encode_jpeg_from_bgra(&scaled, out_w as usize, out_h as usize, (out_w as usize) * 4, quality)?;
    Ok(CaptureResult {
        data_base64: base64::engine::general_purpose::STANDARD.encode(&jpeg),
        mime: "image/jpeg".to_string(),
        width: out_w,
        height: out_h,
        logical_width: lw,
        logical_height: lh,
        logical_origin_x: ox,
        logical_origin_y: oy,
        scale: (out_w as f64) / (lw.max(1) as f64),
        target: label,
        backend: "x11".to_string(),
    })
}

struct StreamParams {
    target: CaptureTargetKind,
    fps: u32,
    max_dim: u32,
    bitrate: u32,
}

pub struct VideoStreamHandle {
    params: Arc<Mutex<StreamParams>>,
    force_keyframe: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
}

impl VideoStreamHandle {
    pub fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::SeqCst);
    }

    pub fn retarget(
        &self,
        target: CaptureTargetKind,
        fps: u32,
        max_dim: u32,
        bitrate: u32,
    ) -> Result<()> {
        let mut guard = self
            .params
            .lock()
            .map_err(|_| anyhow!("stream params lock poisoned"))?;
        guard.target = target;
        guard.fps = fps;
        guard.max_dim = max_dim;
        guard.bitrate = bitrate;
        self.force_keyframe.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl Drop for VideoStreamHandle {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

fn build_openh264(fps: u32, bitrate: u32) -> Result<Encoder> {
    let config = EncoderConfig::new()
        .bitrate(BitRate::from_bps(bitrate.clamp(300_000, 10_000_000)))
        .max_frame_rate(FrameRate::from_hz(fps.clamp(1, 60) as f32))
        .usage_type(UsageType::ScreenContentRealTime)
        .rate_control_mode(RateControlMode::Bitrate)
        .sps_pps_strategy(SpsPpsStrategy::ConstantId)
        .skip_frames(false);
    Encoder::with_api_config(OpenH264API::from_source(), config)
        .map_err(|e| anyhow!("OpenH264 init failed: {e}"))
}

pub fn start_video_stream(
    target: CaptureTargetKind,
    fps: u32,
    max_dim: u32,
    bitrate: u32,
    tx: mpsc::Sender<VideoFrame>,
) -> Result<VideoStreamHandle> {
    let (conn, _screen_num, screen) = connect_x11()?;
    let params = Arc::new(Mutex::new(StreamParams {
        target,
        fps,
        max_dim,
        bitrate,
    }));
    let force_keyframe = Arc::new(AtomicBool::new(true));
    let stopped = Arc::new(AtomicBool::new(false));

    let p_clone = params.clone();
    let fk_clone = force_keyframe.clone();
    let st_clone = stopped.clone();

    std::thread::Builder::new()
        .name("bot-x11-stream".to_string())
        .spawn(move || {
            let mut cur_w = 0u32;
            let mut cur_h = 0u32;
            let mut cur_fps = fps;
            let mut cur_bitrate = bitrate;
            let mut encoder = match build_openh264(cur_fps, cur_bitrate) {
                Ok(e) => e,
                Err(e) => {
                    tracing::error!("{e}");
                    return;
                }
            };
            let start = Instant::now();
            while !st_clone.load(Ordering::SeqCst) {
                let tick_start = Instant::now();
                let (tgt, fps_now, max_dim_now, br_now) = match p_clone.lock() {
                    Ok(g) => (g.target.clone(), g.fps, g.max_dim, g.bitrate),
                    Err(_) => break,
                };
                if fps_now != cur_fps || br_now != cur_bitrate {
                    cur_fps = fps_now;
                    cur_bitrate = br_now;
                    if let Ok(new_enc) = build_openh264(cur_fps, cur_bitrate) {
                        encoder = new_enc;
                        fk_clone.store(true, Ordering::SeqCst);
                    }
                }
                if let Ok((drawable, ox, oy, lw, lh, _)) = resolve_target_x11(&conn, &screen, &tgt)
                {
                    let (req_x, req_y) = match tgt {
                        CaptureTargetKind::Window(_) => (0i16, 0i16),
                        CaptureTargetKind::Screen(_) => (ox as i16, oy as i16),
                    };
                    let (out_w, out_h) = fit_within_max_dim(lw, lh, max_dim_now);
                    if out_w != cur_w || out_h != cur_h {
                        cur_w = out_w;
                        cur_h = out_h;
                        if let Ok(new_enc) = build_openh264(cur_fps, cur_bitrate) {
                            encoder = new_enc;
                            fk_clone.store(true, Ordering::SeqCst);
                        }
                    }
                    if let Ok(raw) =
                        capture_x11_bgra(&conn, drawable, req_x, req_y, lw as u16, lh as u16)
                    {
                        let scaled = downscale_bgra(&raw, lw as usize, lh as usize, (lw as usize) * 4, out_w as usize, out_h as usize);
                        let yuv = YUVBuffer::from_bgra8_source(BgraSliceU8::new(
                            &scaled,
                            (out_w as usize, out_h as usize),
                        ));
                        let force_key = fk_clone.swap(false, Ordering::SeqCst);
                        if force_key {
                            encoder.force_intra_frame();
                        }
                        if let Ok(bs) = encoder.encode(&yuv) {
                            let annexb = bs.to_vec();
                            if !annexb.is_empty() {
                                let is_keyframe = force_key || contains_idr_annexb(&annexb);
                                let pts_us = start.elapsed().as_micros() as u64;
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
                        }
                    }
                }
                let frame_dur = Duration::from_micros(1_000_000 / cur_fps.clamp(1, 60) as u64);
                if let Some(rem) = frame_dur.checked_sub(tick_start.elapsed()) {
                    std::thread::sleep(rem);
                }
            }
        })
        .context("failed to spawn x11 stream thread")?;

    Ok(VideoStreamHandle {
        params,
        force_keyframe,
        stopped,
    })
}

fn find_keycode_for_keysym(conn: &RustConnection, keysym: u32) -> Option<(u8, bool)> {
    let min_kc = conn.setup().min_keycode;
    let max_kc = conn.setup().max_keycode;
    let count = max_kc.saturating_sub(min_kc).saturating_add(1);
    let mapping = conn.get_keyboard_mapping(min_kc, count).ok()?.reply().ok()?;
    let per = mapping.keysyms_per_keycode as usize;
    if per == 0 {
        return None;
    }
    for (idx, chunk) in mapping.keysyms.chunks(per).enumerate() {
        let kc = min_kc.wrapping_add(idx as u8);
        if chunk.first() == Some(&keysym) {
            return Some((kc, false));
        }
        if chunk.get(1) == Some(&keysym) {
            return Some((kc, true));
        }
    }
    None
}

pub fn inject_input(ev: &RemoteInputEvent) -> Result<()> {
    let (conn, _screen_num, screen) = connect_x11()?;
    let root = screen.root;
    match ev.kind.as_str() {
        "move" => {
            let x = ev.x.unwrap_or(0.0).round() as i16;
            let y = ev.y.unwrap_or(0.0).round() as i16;
            conn.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, 0, root, x, y, 0)?;
            conn.flush()?;
        }
        "down" | "up" => {
            let x = ev.x.unwrap_or(0.0).round() as i16;
            let y = ev.y.unwrap_or(0.0).round() as i16;
            let btn = match ev.button.as_deref().unwrap_or("left") {
                "middle" => 2u8,
                "right" => 3u8,
                _ => 1u8,
            };
            conn.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, 0, root, x, y, 0)?;
            let ev_type = if ev.kind == "down" {
                BUTTON_PRESS_EVENT
            } else {
                BUTTON_RELEASE_EVENT
            };
            conn.xtest_fake_input(ev_type, btn, 0, root, 0, 0, 0)?;
            conn.flush()?;
        }
        "wheel" => {
            let dy = ev.dy.unwrap_or(0.0);
            let dx = ev.dx.unwrap_or(0.0);
            if dy != 0.0 {
                let btn = if dy > 0.0 { 5u8 } else { 4u8 };
                let ticks = ((dy.abs() / 16.0).round() as usize).clamp(1, 10);
                for _ in 0..ticks {
                    conn.xtest_fake_input(BUTTON_PRESS_EVENT, btn, 0, root, 0, 0, 0)?;
                    conn.xtest_fake_input(BUTTON_RELEASE_EVENT, btn, 0, root, 0, 0, 0)?;
                }
            }
            if dx != 0.0 {
                let btn = if dx > 0.0 { 7u8 } else { 6u8 };
                let ticks = ((dx.abs() / 16.0).round() as usize).clamp(1, 10);
                for _ in 0..ticks {
                    conn.xtest_fake_input(BUTTON_PRESS_EVENT, btn, 0, root, 0, 0, 0)?;
                    conn.xtest_fake_input(BUTTON_RELEASE_EVENT, btn, 0, root, 0, 0, 0)?;
                }
            }
            conn.flush()?;
        }
        "keydown" | "keyup" => {
            let keysym = map_web_key_to_x11_keysym(ev.code.as_deref(), ev.key.as_deref())
                .ok_or_else(|| anyhow!("Unmapped key code={:?} key={:?}", ev.code, ev.key))?;
            let (kc, _) = find_keycode_for_keysym(&conn, keysym)
                .ok_or_else(|| anyhow!("Keysym 0x{keysym:x} not mapped in X11 keymap"))?;
            let ev_type = if ev.kind == "keydown" {
                KEY_PRESS_EVENT
            } else {
                KEY_RELEASE_EVENT
            };
            conn.xtest_fake_input(ev_type, kc, 0, root, 0, 0, 0)?;
            conn.flush()?;
        }
        "text" => {
            if let Some(t) = ev.text.as_deref() {
                inject_text(t)?;
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
    let (conn, _screen_num, screen) = connect_x11()?;
    let root = screen.root;
    let shift_kc = find_keycode_for_keysym(&conn, 0xffe1).map(|(kc, _)| kc);

    let mut all_mapped = true;
    for ch in text.chars() {
        let keysym = match ch {
            '\n' | '\r' => 0xff0d,
            '\t' => 0xff09,
            ' ' => 0x0020,
            c if (c as u32) >= 0x20 && (c as u32) <= 0x7e => c as u32,
            c => 0x0100_0000 | (c as u32),
        };
        if let Some((kc, need_shift)) = find_keycode_for_keysym(&conn, keysym) {
            if need_shift {
                if let Some(skc) = shift_kc {
                    conn.xtest_fake_input(KEY_PRESS_EVENT, skc, 0, root, 0, 0, 0)?;
                }
            }
            conn.xtest_fake_input(KEY_PRESS_EVENT, kc, 0, root, 0, 0, 0)?;
            conn.xtest_fake_input(KEY_RELEASE_EVENT, kc, 0, root, 0, 0, 0)?;
            if need_shift {
                if let Some(skc) = shift_kc {
                    conn.xtest_fake_input(KEY_RELEASE_EVENT, skc, 0, root, 0, 0, 0)?;
                }
            }
        } else {
            all_mapped = false;
            break;
        }
    }
    conn.flush()?;

    if !all_mapped {
        if let Some(xdotool) = resolve_binary("xdotool") {
            let status = std::process::Command::new(xdotool)
                .args(["type", "--clearmodifiers", "--delay", "2", "--", text])
                .status()?;
            if !status.success() {
                return Err(anyhow!("xdotool type failed with {status}"));
            }
            return Ok(());
        }
        return Err(anyhow!(
            "Some characters could not be typed via XTest and xdotool is not installed"
        ));
    }
    Ok(())
}

pub fn set_keep_awake(enabled: bool) -> Result<bool> {
    if enabled {
        if KEEP_AWAKE_ACTIVE.load(Ordering::SeqCst) {
            return Ok(true);
        }
        if let Ok(conn) = zbus::blocking::Connection::session() {
            if let Ok(reply) = conn.call_method(
                Some("org.freedesktop.ScreenSaver"),
                "/org/freedesktop/ScreenSaver",
                Some("org.freedesktop.ScreenSaver"),
                "Inhibit",
                &("opencode-bot", "Remote desktop session active"),
            ) {
                if let Ok(cookie) = reply.body().deserialize::<u32>() {
                    KEEP_AWAKE_COOKIE.store(cookie, Ordering::SeqCst);
                }
            }
        }
        KEEP_AWAKE_ACTIVE.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        let cookie = KEEP_AWAKE_COOKIE.swap(0, Ordering::SeqCst);
        if cookie != 0 {
            if let Ok(conn) = zbus::blocking::Connection::session() {
                let _ = conn.call_method(
                    Some("org.freedesktop.ScreenSaver"),
                    "/org/freedesktop/ScreenSaver",
                    Some("org.freedesktop.ScreenSaver"),
                    "UnInhibit",
                    &(cookie,),
                );
            }
        }
        KEEP_AWAKE_ACTIVE.store(false, Ordering::SeqCst);
        Ok(false)
    }
}

pub fn is_keep_awake() -> bool {
    KEEP_AWAKE_ACTIVE.load(Ordering::SeqCst)
}

fn map_web_key_to_x11_keysym(code: Option<&str>, key: Option<&str>) -> Option<u32> {
    if let Some(c) = code {
        let ks = match c {
            "Enter" | "NumpadEnter" => Some(0xff0d),
            "Tab" => Some(0xff09),
            "Space" => Some(0x0020),
            "Backspace" => Some(0xff08),
            "Escape" => Some(0xff1b),
            "Delete" => Some(0xffff),
            "Home" => Some(0xff50),
            "End" => Some(0xff57),
            "PageUp" => Some(0xff55),
            "PageDown" => Some(0xff56),
            "ArrowLeft" => Some(0xff51),
            "ArrowUp" => Some(0xff52),
            "ArrowRight" => Some(0xff53),
            "ArrowDown" => Some(0xff54),
            "ShiftLeft" => Some(0xffe1),
            "ShiftRight" => Some(0xffe2),
            "ControlLeft" => Some(0xffe3),
            "ControlRight" => Some(0xffe4),
            "AltLeft" => Some(0xffe9),
            "AltRight" => Some(0xffea),
            "MetaLeft" => Some(0xffeb),
            "MetaRight" => Some(0xffec),
            "CapsLock" => Some(0xffe5),
            "F1" => Some(0xffbe),
            "F2" => Some(0xffbf),
            "F3" => Some(0xffc0),
            "F4" => Some(0xffc1),
            "F5" => Some(0xffc2),
            "F6" => Some(0xffc3),
            "F7" => Some(0xffc4),
            "F8" => Some(0xffc5),
            "F9" => Some(0xffc6),
            "F10" => Some(0xffc7),
            "F11" => Some(0xffc8),
            "F12" => Some(0xffc9),
            s if s.starts_with("Key") && s.len() == 4 => {
                Some(s.as_bytes()[3].to_ascii_lowercase() as u32)
            }
            s if s.starts_with("Digit") && s.len() == 6 => Some(s.as_bytes()[5] as u32),
            _ => None,
        };
        if ks.is_some() {
            return ks;
        }
    }
    match key? {
        "Enter" => Some(0xff0d),
        "Tab" => Some(0xff09),
        " " | "Spacebar" => Some(0x0020),
        "Backspace" => Some(0xff08),
        "Escape" | "Esc" => Some(0xff1b),
        "Delete" => Some(0xffff),
        "ArrowLeft" => Some(0xff51),
        "ArrowUp" => Some(0xff52),
        "ArrowRight" => Some(0xff53),
        "ArrowDown" => Some(0xff54),
        s if s.chars().count() == 1 => {
            let ch = s.chars().next()?;
            if (ch as u32) >= 0x20 && (ch as u32) <= 0x7e {
                Some(ch as u32)
            } else {
                None
            }
        }
        _ => None,
    }
}

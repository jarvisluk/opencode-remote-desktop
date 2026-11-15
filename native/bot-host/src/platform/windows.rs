use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, RateControlMode, SpsPpsStrategy, UsageType};
use openh264::formats::{BgraSliceU8, YUVBuffer};
use openh264::OpenH264API;
use tokio::sync::mpsc;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFO, SRCCOPY,
};
use windows::Win32::System::Power::{
    SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8,
    VK_F9, VK_HOME, VK_LEFT, VK_LWIN, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT,
    VK_RWIN, VK_SHIFT, VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetSystemMetrics, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, IsWindowVisible, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

use crate::browser::{discover_browser, resolve_binary};
use crate::h264::{contains_idr_annexb, downscale_bgra, encode_jpeg_from_bgra, fit_within_max_dim};
use crate::protocol::{
    CaptureResult, CaptureTargetKind, DisplayInfo, HostStatus, RemoteInputEvent, WindowInfo,
};

use super::VideoFrame;

const MONITORINFOF_PRIMARY: u32 = 1;
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);

pub fn host_status() -> HostStatus {
    let browser = discover_browser();
    HostStatus {
        platform: "win32".to_string(),
        arch: std::env::consts::ARCH.to_string(),
        supported: true,
        accessibility: "granted".to_string(),
        screen_recording: "granted".to_string(),
        backend: "win32-gdi".to_string(),
        stream_backend: "openh264".to_string(),
        agent_desktop_bin: resolve_binary("agent-desktop"),
        agent_browser_bin: browser.agent_browser_bin,
        displays: list_displays().unwrap_or_default(),
        keep_awake: is_keep_awake(),
        note: None,
    }
}

unsafe extern "system" fn enum_monitor_cb(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<DisplayInfo>);
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(hmonitor, &mut info).as_bool() {
        let idx = list.len();
        let is_primary = (info.dwFlags & MONITORINFOF_PRIMARY) != 0;
        let r = info.rcMonitor;
        list.push(DisplayInfo {
            id: format!("{}", idx),
            name: if is_primary {
                format!("Display {} (Primary)", idx + 1)
            } else {
                format!("Display {}", idx + 1)
            },
            width: (r.right - r.left).max(1) as u32,
            height: (r.bottom - r.top).max(1) as u32,
            x: r.left,
            y: r.top,
            is_primary,
        });
    }
    BOOL(1)
}

pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    let mut list: Vec<DisplayInfo> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(enum_monitor_cb),
            LPARAM((&mut list as *mut Vec<DisplayInfo>) as isize),
        )
    };
    if !ok.as_bool() && list.is_empty() {
        return Err(anyhow!("EnumDisplayMonitors failed"));
    }
    list.sort_by_key(|d| !d.is_primary);
    Ok(list)
}

struct WinEnumCtx {
    windows: Vec<WindowInfo>,
    foreground: isize,
}

unsafe extern "system" fn enum_window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() {
        return BOOL(1);
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w < 40 || h < 40 {
        return BOOL(1);
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buf);
    let title = String::from_utf16_lossy(&buf[..copied as usize]);
    if title.trim().is_empty() {
        return BOOL(1);
    }

    let ctx = &mut *(lparam.0 as *mut WinEnumCtx);
    ctx.windows.push(WindowInfo {
        id: format!("w-{}", hwnd.0 as isize),
        app: String::new(),
        title,
        x: rect.left,
        y: rect.top,
        width: w as u32,
        height: h as u32,
        display_id: None,
        focused: hwnd.0 as isize == ctx.foreground,
    });
    BOOL(1)
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    let fg = unsafe { GetForegroundWindow() };
    let mut ctx = WinEnumCtx {
        windows: Vec::new(),
        foreground: fg.0 as isize,
    };
    unsafe {
        EnumWindows(
            Some(enum_window_cb),
            LPARAM((&mut ctx as *mut WinEnumCtx) as isize),
        )?;
    }
    Ok(ctx.windows)
}

fn resolve_target_rect(target: &CaptureTargetKind) -> Result<(i32, i32, u32, u32, String)> {
    match target {
        CaptureTargetKind::Window(wid) => {
            let hwnd = HWND((*wid as isize) as *mut std::ffi::c_void);
            let mut rect = RECT::default();
            unsafe { GetWindowRect(hwnd, &mut rect) }
                .map_err(|e| anyhow!("Window w-{wid} not found: {e}"))?;
            let w = (rect.right - rect.left).max(2) as u32;
            let h = (rect.bottom - rect.top).max(2) as u32;
            Ok((rect.left, rect.top, w, h, format!("w-{wid}")))
        }
        CaptureTargetKind::Screen(idx) => {
            let displays = list_displays()?;
            let d = displays
                .get(*idx as usize)
                .or_else(|| displays.first())
                .ok_or_else(|| anyhow!("No displays found"))?;
            Ok((d.x, d.y, d.width.max(2), d.height.max(2), format!("screen:{idx}")))
        }
    }
}

fn capture_rect_bgra(x: i32, y: i32, w: u32, h: u32) -> Result<Vec<u8>> {
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err(anyhow!("GetDC failed"));
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err(anyhow!("CreateCompatibleDC failed"));
        }
        let bmp = CreateCompatibleBitmap(screen_dc, w as i32, h as i32);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err(anyhow!("CreateCompatibleBitmap failed"));
        }
        let old = SelectObject(mem_dc, bmp.into());
        let bitblt_res = BitBlt(mem_dc, 0, 0, w as i32, h as i32, Some(screen_dc), x, y, SRCCOPY);
        if let Err(e) = bitblt_res {
            SelectObject(mem_dc, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err(anyhow!("BitBlt failed: {e}"));
        }

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w as i32;
        bmi.bmiHeader.biHeight = -(h as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bmp,
            0,
            h,
            Some(buf.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(mem_dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if lines == 0 {
            return Err(anyhow!("GetDIBits failed"));
        }
        Ok(buf)
    }
}

pub fn capture_jpeg(
    target: CaptureTargetKind,
    max_dim: u32,
    quality: u8,
) -> Result<CaptureResult> {
    let (ox, oy, lw, lh, label) = resolve_target_rect(&target)?;
    let raw = capture_rect_bgra(ox, oy, lw, lh)?;
    let (out_w, out_h) = fit_within_max_dim(lw, lh, max_dim);
    let scaled = downscale_bgra(&raw, lw, lh, out_w, out_h);
    let jpeg = encode_jpeg_from_bgra(&scaled, out_w, out_h, quality)?;
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
        backend: "win32-gdi".to_string(),
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
        .name("bot-win-stream".to_string())
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
                if let Ok((ox, oy, lw, lh, _)) = resolve_target_rect(&tgt) {
                    let (out_w, out_h) = fit_within_max_dim(lw, lh, max_dim_now);
                    if out_w != cur_w || out_h != cur_h {
                        cur_w = out_w;
                        cur_h = out_h;
                        if let Ok(new_enc) = build_openh264(cur_fps, cur_bitrate) {
                            encoder = new_enc;
                            fk_clone.store(true, Ordering::SeqCst);
                        }
                    }
                    if let Ok(raw) = capture_rect_bgra(ox, oy, lw, lh) {
                        let scaled = downscale_bgra(&raw, lw, lh, out_w, out_h);
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
        .context("failed to spawn windows stream thread")?;

    Ok(VideoStreamHandle {
        params,
        force_keyframe,
        stopped,
    })
}

fn mouse_abs_coords(x: f64, y: f64) -> (i32, i32) {
    let vx = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) } as f64;
    let vy = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) } as f64;
    let vw = (unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }).max(1) as f64;
    let vh = (unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }).max(1) as f64;
    let nx = (((x - vx) * 65535.0) / vw).round().clamp(0.0, 65535.0) as i32;
    let ny = (((y - vy) * 65535.0) / vh).round().clamp(0.0, 65535.0) as i32;
    (nx, ny)
}

fn send_inputs(inputs: &[INPUT]) {
    if !inputs.is_empty() {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

pub fn inject_input(ev: &RemoteInputEvent) -> Result<()> {
    match ev.kind.as_str() {
        "move" => {
            let (nx, ny) = mouse_abs_coords(ev.x.unwrap_or(0.0), ev.y.unwrap_or(0.0));
            let inp = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: nx,
                        dy: ny,
                        dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                        ..Default::default()
                    },
                },
            };
            send_inputs(&[inp]);
        }
        "down" | "up" => {
            let is_down = ev.kind == "down";
            let (nx, ny) = mouse_abs_coords(ev.x.unwrap_or(0.0), ev.y.unwrap_or(0.0));
            let btn_flag = match ev.button.as_deref().unwrap_or("left") {
                "right" => {
                    if is_down {
                        MOUSEEVENTF_RIGHTDOWN
                    } else {
                        MOUSEEVENTF_RIGHTUP
                    }
                }
                "middle" => {
                    if is_down {
                        MOUSEEVENTF_MIDDLEDOWN
                    } else {
                        MOUSEEVENTF_MIDDLEUP
                    }
                }
                _ => {
                    if is_down {
                        MOUSEEVENTF_LEFTDOWN
                    } else {
                        MOUSEEVENTF_LEFTUP
                    }
                }
            };
            let inp = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT {
                        dx: nx,
                        dy: ny,
                        dwFlags: MOUSEEVENTF_MOVE
                            | MOUSEEVENTF_ABSOLUTE
                            | MOUSEEVENTF_VIRTUALDESK
                            | btn_flag,
                        ..Default::default()
                    },
                },
            };
            send_inputs(&[inp]);
        }
        "wheel" => {
            let mut list = Vec::new();
            let dy = -(ev.dy.unwrap_or(0.0).round() as i32);
            let dx = ev.dx.unwrap_or(0.0).round() as i32;
            if dy != 0 {
                list.push(INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            mouseData: (dy * 3) as u32,
                            dwFlags: MOUSEEVENTF_WHEEL,
                            ..Default::default()
                        },
                    },
                });
            }
            if dx != 0 {
                list.push(INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            mouseData: (dx * 3) as u32,
                            dwFlags: MOUSEEVENTF_HWHEEL,
                            ..Default::default()
                        },
                    },
                });
            }
            send_inputs(&list);
        }
        "keydown" | "keyup" => {
            let is_down = ev.kind == "keydown";
            let vk = map_web_key_to_vk(ev.code.as_deref(), ev.key.as_deref())
                .ok_or_else(|| anyhow!("Unmapped key code={:?} key={:?}", ev.code, ev.key))?;
            let flags = if is_down {
                Default::default()
            } else {
                KEYEVENTF_KEYUP
            };
            let inp = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        dwFlags: flags,
                        ..Default::default()
                    },
                },
            };
            send_inputs(&[inp]);
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
    let mut inputs = Vec::with_capacity(text.len() * 2);
    for code_unit in text.encode_utf16() {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: code_unit,
                    dwFlags: KEYEVENTF_UNICODE,
                    ..Default::default()
                },
            },
        });
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: code_unit,
                    dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                    ..Default::default()
                },
            },
        });
    }
    send_inputs(&inputs);
    Ok(())
}

pub fn set_keep_awake(enabled: bool) -> Result<bool> {
    if enabled {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        }
        KEEP_AWAKE.store(true, Ordering::SeqCst);
        Ok(true)
    } else {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
        KEEP_AWAKE.store(false, Ordering::SeqCst);
        Ok(false)
    }
}

pub fn is_keep_awake() -> bool {
    KEEP_AWAKE.load(Ordering::SeqCst)
}

fn map_web_key_to_vk(code: Option<&str>, key: Option<&str>) -> Option<VIRTUAL_KEY> {
    if let Some(c) = code {
        let vk = match c {
            "Enter" | "NumpadEnter" => Some(VK_RETURN),
            "Tab" => Some(VK_TAB),
            "Space" => Some(VK_SPACE),
            "Backspace" => Some(VK_BACK),
            "Escape" => Some(VK_ESCAPE),
            "Delete" => Some(VK_DELETE),
            "Home" => Some(VK_HOME),
            "End" => Some(VK_END),
            "PageUp" => Some(VK_PRIOR),
            "PageDown" => Some(VK_NEXT),
            "ArrowLeft" => Some(VK_LEFT),
            "ArrowRight" => Some(VK_RIGHT),
            "ArrowUp" => Some(VK_UP),
            "ArrowDown" => Some(VK_DOWN),
            "ShiftLeft" | "ShiftRight" => Some(VK_SHIFT),
            "ControlLeft" | "ControlRight" => Some(VK_CONTROL),
            "AltLeft" | "AltRight" => Some(VK_MENU),
            "MetaLeft" => Some(VK_LWIN),
            "MetaRight" => Some(VK_RWIN),
            "CapsLock" => Some(VK_CAPITAL),
            "F1" => Some(VK_F1),
            "F2" => Some(VK_F2),
            "F3" => Some(VK_F3),
            "F4" => Some(VK_F4),
            "F5" => Some(VK_F5),
            "F6" => Some(VK_F6),
            "F7" => Some(VK_F7),
            "F8" => Some(VK_F8),
            "F9" => Some(VK_F9),
            "F10" => Some(VK_F10),
            "F11" => Some(VK_F11),
            "F12" => Some(VK_F12),
            s if s.starts_with("Key") && s.len() == 4 => {
                let b = s.as_bytes()[3].to_ascii_uppercase();
                Some(VIRTUAL_KEY(b as u16))
            }
            s if s.starts_with("Digit") && s.len() == 6 => {
                let b = s.as_bytes()[5];
                Some(VIRTUAL_KEY(b as u16))
            }
            _ => None,
        };
        if vk.is_some() {
            return vk;
        }
    }
    match key? {
        "Enter" => Some(VK_RETURN),
        "Tab" => Some(VK_TAB),
        " " | "Spacebar" => Some(VK_SPACE),
        "Backspace" => Some(VK_BACK),
        "Escape" | "Esc" => Some(VK_ESCAPE),
        "Delete" => Some(VK_DELETE),
        "ArrowLeft" => Some(VK_LEFT),
        "ArrowRight" => Some(VK_RIGHT),
        "ArrowUp" => Some(VK_UP),
        "ArrowDown" => Some(VK_DOWN),
        s if s.len() == 1 => {
            let b = s.as_bytes()[0].to_ascii_uppercase();
            if b.is_ascii_alphanumeric() {
                Some(VIRTUAL_KEY(b as u16))
            } else {
                None
            }
        }
        _ => None,
    }
}

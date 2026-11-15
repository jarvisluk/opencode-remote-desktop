use anyhow::{anyhow, Result};

use crate::browser::{discover_browser, resolve_binary};
use crate::protocol::{
    CaptureResult, CaptureTargetKind, DisplayInfo, HostStatus, RemoteInputEvent, WindowInfo,
};

use super::VideoFrame;

pub struct VideoStreamHandle;

impl VideoStreamHandle {
    pub fn request_keyframe(&self) {}

    pub fn retarget(
        &self,
        _target: CaptureTargetKind,
        _fps: u32,
        _max_dim: u32,
        _bitrate: u32,
    ) -> Result<()> {
        Err(anyhow!("Unsupported platform"))
    }
}

pub fn host_status() -> HostStatus {
    let browser = discover_browser();
    HostStatus {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        supported: false,
        accessibility: "unknown".to_string(),
        screen_recording: "unknown".to_string(),
        backend: "none".to_string(),
        stream_backend: "none".to_string(),
        agent_desktop_bin: resolve_binary("agent-desktop"),
        agent_browser_bin: browser.agent_browser_bin,
        displays: Vec::new(),
        keep_awake: false,
        note: Some("Unsupported platform".to_string()),
    }
}

pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    Ok(Vec::new())
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    Ok(Vec::new())
}

pub fn capture_jpeg(
    _target: CaptureTargetKind,
    _max_dim: u32,
    _quality: u8,
) -> Result<CaptureResult> {
    Err(anyhow!("Screen capture is not supported on this platform"))
}

pub fn start_video_stream(
    _target: CaptureTargetKind,
    _fps: u32,
    _max_dim: u32,
    _bitrate: u32,
    _tx: tokio::sync::mpsc::Sender<VideoFrame>,
) -> Result<VideoStreamHandle> {
    Err(anyhow!("Live video streaming is not supported on this platform"))
}

pub fn inject_input(_ev: &RemoteInputEvent) -> Result<()> {
    Err(anyhow!("Input injection is not supported on this platform"))
}

pub fn inject_text(_text: &str) -> Result<()> {
    Err(anyhow!("Text injection is not supported on this platform"))
}

pub fn set_keep_awake(_enabled: bool) -> Result<bool> {
    Ok(false)
}

pub fn is_keep_awake() -> bool {
    false
}

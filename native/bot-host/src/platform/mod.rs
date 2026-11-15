use anyhow::Result;

use crate::protocol::{
    CaptureResult, CaptureTargetKind, DisplayInfo, HostStatus, RemoteInputEvent, WindowInfo,
};

#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub annexb: Vec<u8>,
    pub pts_us: u64,
    #[allow(dead_code)]
    pub is_keyframe: bool,
}

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos as imp;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows as imp;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub use linux as imp;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub mod unsupported;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use unsupported as imp;

pub use imp::VideoStreamHandle;

pub fn host_status() -> HostStatus {
    imp::host_status()
}

pub fn list_displays() -> Result<Vec<DisplayInfo>> {
    imp::list_displays()
}

pub fn list_windows() -> Result<Vec<WindowInfo>> {
    imp::list_windows()
}

pub fn capture_jpeg(
    target: CaptureTargetKind,
    max_dim: u32,
    quality: u8,
) -> Result<CaptureResult> {
    imp::capture_jpeg(target, max_dim, quality)
}

pub fn start_video_stream(
    target: CaptureTargetKind,
    fps: u32,
    max_dim: u32,
    bitrate: u32,
    tx: tokio::sync::mpsc::Sender<VideoFrame>,
) -> Result<VideoStreamHandle> {
    imp::start_video_stream(target, fps, max_dim, bitrate, tx)
}

pub fn inject_input(ev: &RemoteInputEvent) -> Result<()> {
    imp::inject_input(ev)
}

pub fn inject_text(text: &str) -> Result<()> {
    imp::inject_text(text)
}

pub fn set_keep_awake(enabled: bool) -> Result<bool> {
    imp::set_keep_awake(enabled)
}

#[allow(dead_code)]
pub fn is_keep_awake() -> bool {
    imp::is_keep_awake()
}

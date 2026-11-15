use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct RpcRequest {
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, code: i32, message: String) -> Self {
        Self {
            id,
            result: None,
            error: Some(RpcError { code, message }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: String,
    pub app: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_id: Option<String>,
    pub focused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub platform: String,
    pub arch: String,
    pub supported: bool,
    pub accessibility: String,
    pub screen_recording: String,
    pub backend: String,
    pub stream_backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_desktop_bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_browser_bin: Option<String>,
    pub displays: Vec<DisplayInfo>,
    pub keep_awake: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureParams {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub display: Option<u32>,
    #[serde(default)]
    pub max_dim: Option<u32>,
    #[serde(default)]
    pub quality: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub data_base64: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub logical_width: u32,
    pub logical_height: u32,
    pub logical_origin_x: i32,
    pub logical_origin_y: i32,
    pub scale: f64,
    pub target: String,
    pub backend: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct IceServerConfig {
    pub urls: Vec<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOfferParams {
    pub sdp: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub max_dim: Option<u32>,
    #[serde(default)]
    pub bitrate: Option<u32>,
    #[serde(default)]
    pub ice_servers: Option<Vec<IceServerConfig>>,
    #[serde(default)]
    pub gather_timeout_ms: Option<u64>,
    #[serde(default)]
    pub idle_stop_ms: Option<u64>,
    #[serde(default)]
    pub ffmpeg_cmd: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOfferResult {
    pub sdp: String,
    pub session: String,
    pub codec: String,
    pub backend: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRetargetParams {
    pub session: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub fps: Option<u32>,
    #[serde(default)]
    pub max_dim: Option<u32>,
    #[serde(default)]
    pub bitrate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamCloseParams {
    #[serde(default)]
    pub session: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSetInputParams {
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInputEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub dx: Option<f64>,
    #[serde(default)]
    pub dy: Option<f64>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub shift: Option<bool>,
    #[serde(default)]
    pub ctrl: Option<bool>,
    #[serde(default)]
    pub alt: Option<bool>,
    #[serde(default)]
    pub meta: Option<bool>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub display: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerKeepAwakeParams {
    pub enabled: bool,
    #[serde(default)]
    #[allow(dead_code)]
    pub owner_pid: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretNameParams {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretSetParams {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHasParams {
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDiscovery {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_browser_bin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_ws_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
#[allow(dead_code)]
pub struct CaptureTargetSpec {
    pub kind: CaptureTargetKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureTargetKind {
    Screen(u32),
    Window(u32),
}

impl Default for CaptureTargetKind {
    fn default() -> Self {
        Self::Screen(0)
    }
}

pub fn parse_capture_target(target: Option<&str>, display: Option<u32>) -> CaptureTargetKind {
    if let Some(raw) = target.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(rest) = raw.strip_prefix("w-") {
            if let Ok(wid) = rest.parse::<u32>() {
                return CaptureTargetKind::Window(wid);
            }
        }
        if let Some(rest) = raw.strip_prefix("screen:") {
            if let Ok(idx) = rest.parse::<u32>() {
                return CaptureTargetKind::Screen(idx);
            }
        }
        if let Ok(idx) = raw.parse::<u32>() {
            return CaptureTargetKind::Screen(idx);
        }
    }
    if let Some(idx) = display {
        return CaptureTargetKind::Screen(idx);
    }
    CaptureTargetKind::Screen(0)
}

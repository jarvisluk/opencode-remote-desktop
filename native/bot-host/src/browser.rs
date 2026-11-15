use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::protocol::BrowserDiscovery;

pub fn resolve_binary(name: &str) -> Option<String> {
    let candidates = candidate_bin_dirs();
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    for dir in candidates {
        let p = dir.join(&exe_name);
        if is_executable(&p) {
            return Some(p.to_string_lossy().into_owned());
        }
        #[cfg(windows)]
        {
            for ext in ["cmd", "bat"] {
                let alt = dir.join(format!("{name}.{ext}"));
                if alt.is_file() {
                    return Some(alt.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(path_env) = std::env::var("PATH") {
        for part in std::env::split_paths(&path_env) {
            dirs.push(part);
        }
    }
    #[cfg(target_os = "macos")]
    {
        for extra in [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            dirs.push(PathBuf::from(extra));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(home) = home_dir() {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".cargo/bin"));
        }
        for extra in ["/usr/local/bin", "/usr/bin", "/bin"] {
            dirs.push(PathBuf::from(extra));
        }
    }
    dirs
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            return (meta.permissions().mode() & 0o111) != 0;
        }
        false
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

pub fn discover_browser() -> BrowserDiscovery {
    let agent_browser_bin = resolve_binary("agent-browser");
    let mut out = BrowserDiscovery {
        agent_browser_bin,
        cdp_port: None,
        cdp_ws_url: None,
        browser_name: None,
    };

    for (browser_name, dir) in browser_profile_dirs() {
        let port_file = dir.join("DevToolsActivePort");
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            let mut lines = content.lines();
            if let (Some(port_str), Some(ws_path)) = (lines.next(), lines.next()) {
                if let Ok(port) = port_str.trim().parse::<u16>() {
                    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
                    if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
                        out.cdp_port = Some(port);
                        out.cdp_ws_url =
                            Some(format!("ws://127.0.0.1:{port}{}", ws_path.trim()));
                        out.browser_name = Some(browser_name.to_string());
                        return out;
                    }
                }
            }
        }
    }

    out
}

fn browser_profile_dirs() -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = home_dir() {
        let base = home.join("Library/Application Support");
        out.push(("Google Chrome", base.join("Google/Chrome")));
        out.push(("Microsoft Edge", base.join("Microsoft Edge")));
        out.push(("Brave", base.join("BraveSoftware/Brave-Browser")));
        out.push(("Arc", base.join("Arc/User Data")));
        out.push(("Chromium", base.join("Chromium")));
    }
    #[cfg(target_os = "windows")]
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        out.push(("Google Chrome", local.join("Google/Chrome/User Data")));
        out.push(("Microsoft Edge", local.join("Microsoft/Edge/User Data")));
        out.push(("Brave", local.join("BraveSoftware/Brave-Browser/User Data")));
        out.push(("Chromium", local.join("Chromium/User Data")));
    }
    #[cfg(target_os = "linux")]
    if let Some(home) = home_dir() {
        let cfg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        out.push(("Google Chrome", cfg.join("google-chrome")));
        out.push(("Microsoft Edge", cfg.join("microsoft-edge")));
        out.push(("Brave", cfg.join("BraveSoftware/Brave-Browser")));
        out.push(("Chromium", cfg.join("chromium")));
    }
    out
}

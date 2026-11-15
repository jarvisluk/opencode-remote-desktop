mod browser;
mod h264;
mod ifaces;
mod platform;
mod protocol;
mod secrets;
mod webrtc;

use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::protocol::{
    parse_capture_target, CaptureParams, PowerKeepAwakeParams, RemoteInputEvent, RpcRequest,
    RpcResponse, SecretHasParams, SecretNameParams, SecretSetParams, StreamCloseParams,
    StreamOfferParams, StreamRetargetParams, StreamSetInputParams,
};
use crate::webrtc::SessionManager;

#[tokio::main]
async fn main() -> Result<()> {
    str0m::crypto::from_feature_flags().install_process_default();

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .without_time()
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(first) = args.first().map(String::as_str) {
        match first {
            "--version" | "-V" | "version" => {
                println!("bot-host {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--help" | "-h" | "help" => {
                println!(
                    "bot-host {} — unified native host for opencode-remote-desktop\n\
                     Usage:\n  bot-host [--stdio]         Run stdio JSON-RPC daemon (default)\n  \
                     bot-host --status          Print host capability JSON and exit\n  \
                     bot-host --list-displays   Print displays JSON and exit\n  \
                     bot-host --list-windows    Print windows JSON and exit\n  \
                     bot-host --version         Print version and exit",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(());
            }
            "--status" | "status" => {
                println!("{}", serde_json::to_string_pretty(&platform::host_status())?);
                return Ok(());
            }
            "--list-displays" => {
                let displays = tokio::task::spawn_blocking(platform::list_displays).await??;
                println!("{}", serde_json::to_string_pretty(&displays)?);
                return Ok(());
            }
            "--list-windows" => {
                let windows = tokio::task::spawn_blocking(platform::list_windows).await??;
                println!("{}", serde_json::to_string_pretty(&windows)?);
                return Ok(());
            }
            "--stdio" => {}
            other => {
                eprintln!("Unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }

    run_stdio_rpc().await
}

async fn run_stdio_rpc() -> Result<()> {
    let sessions = Arc::new(SessionManager::new());
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let stdin = BufReader::new(tokio::io::stdin());
    let mut lines = stdin.lines();
    let mut inflight = tokio::task::JoinSet::new();

    while let Ok(Some(line)) = lines.next_line().await {
        while inflight.try_join_next().is_some() {}
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: RpcRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(err) => {
                let resp = RpcResponse::err(Value::Null, -32700, format!("Parse error: {err}"));
                write_response(&stdout, &resp).await;
                continue;
            }
        };

        let sessions_ref = sessions.clone();
        let stdout_ref = stdout.clone();
        inflight.spawn(async move {
            let id = req.id.clone();
            let resp = match dispatch_request(&sessions_ref, req).await {
                Ok(val) => RpcResponse::ok(id, val),
                Err(err) => RpcResponse::err(id, -32000, format!("{err:#}")),
            };
            write_response(&stdout_ref, &resp).await;
        });
    }

    while inflight.join_next().await.is_some() {}
    sessions.close_all().await;
    let _ = tokio::task::spawn_blocking(|| platform::set_keep_awake(false)).await;
    Ok(())
}

async fn write_response(stdout: &Arc<Mutex<tokio::io::Stdout>>, resp: &RpcResponse) {
    if let Ok(mut line) = serde_json::to_string(resp) {
        line.push('\n');
        let mut out = stdout.lock().await;
        let _ = out.write_all(line.as_bytes()).await;
        let _ = out.flush().await;
    }
}

async fn dispatch_request(sessions: &SessionManager, req: RpcRequest) -> Result<Value> {
    match req.method.as_str() {
        "host.ping" => Ok(serde_json::json!({
            "ok": true,
            "version": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })),
        "host.status" => {
            let status = tokio::task::spawn_blocking(platform::host_status).await?;
            Ok(serde_json::to_value(status)?)
        }
        "display.list" => {
            let displays = tokio::task::spawn_blocking(platform::list_displays).await??;
            Ok(serde_json::to_value(displays)?)
        }
        "window.list" => {
            let windows = tokio::task::spawn_blocking(platform::list_windows).await??;
            Ok(serde_json::to_value(windows)?)
        }
        "browser.discover" => {
            let info = tokio::task::spawn_blocking(browser::discover_browser).await?;
            Ok(serde_json::to_value(info)?)
        }
        "screen.capture" => {
            let params: CaptureParams = serde_json::from_value(req.params)?;
            let target = parse_capture_target(params.target.as_deref(), params.display);
            let max_dim = params.max_dim.unwrap_or(1440).clamp(128, 3840);
            let quality = params.quality.unwrap_or(82).clamp(20, 95);
            let res = tokio::task::spawn_blocking(move || {
                platform::capture_jpeg(target, max_dim, quality)
            })
            .await??;
            Ok(serde_json::to_value(res)?)
        }
        "stream.offer" => {
            let params: StreamOfferParams = serde_json::from_value(req.params)?;
            let res = sessions.create_session(params).await?;
            Ok(serde_json::to_value(res)?)
        }
        "stream.retarget" => {
            let params: StreamRetargetParams = serde_json::from_value(req.params)?;
            sessions.retarget_session(params).await?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "stream.close" => {
            let params: StreamCloseParams = serde_json::from_value(req.params)?;
            let closed = match params.session.as_deref() {
                Some(sid) => sessions.close_session(sid).await?,
                None => {
                    sessions.close_all().await;
                    true
                }
            };
            Ok(serde_json::json!({ "ok": true, "closed": closed }))
        }
        "stream.setInput" => {
            let params: StreamSetInputParams = serde_json::from_value(req.params)?;
            sessions.set_input_enabled(params.enabled);
            Ok(serde_json::json!({ "ok": true, "enabled": params.enabled }))
        }
        "input.inject" => {
            let ev: RemoteInputEvent = serde_json::from_value(req.params)?;
            tokio::task::spawn_blocking(move || platform::inject_input(&ev)).await??;
            Ok(serde_json::json!({ "ok": true }))
        }
        "power.keepAwake" => {
            let params: PowerKeepAwakeParams = serde_json::from_value(req.params)?;
            let active =
                tokio::task::spawn_blocking(move || platform::set_keep_awake(params.enabled))
                    .await??;
            Ok(serde_json::json!({ "ok": true, "active": active }))
        }
        "secret.set" => {
            let params: SecretSetParams = serde_json::from_value(req.params)?;
            tokio::task::spawn_blocking(move || secrets::save_secret(&params.name, &params.value))
                .await??;
            Ok(serde_json::json!({ "ok": true }))
        }
        "secret.delete" => {
            let params: SecretNameParams = serde_json::from_value(req.params)?;
            let deleted =
                tokio::task::spawn_blocking(move || secrets::delete_secret(&params.name)).await??;
            Ok(serde_json::json!({ "ok": true, "deleted": deleted }))
        }
        "secret.list" => {
            let list = tokio::task::spawn_blocking(secrets::list_secret_names).await?;
            Ok(serde_json::to_value(list)?)
        }
        "secret.has" => {
            let params: SecretHasParams = serde_json::from_value(req.params)?;
            let map =
                tokio::task::spawn_blocking(move || secrets::has_secrets(&params.names)).await?;
            Ok(serde_json::to_value(map)?)
        }
        "secret.type" => {
            let params: SecretNameParams = serde_json::from_value(req.params)?;
            tokio::task::spawn_blocking(move || secrets::type_secret(&params.name)).await??;
            Ok(serde_json::json!({ "ok": true }))
        }
        "secret.get" => {
            let params: SecretNameParams = serde_json::from_value(req.params)?;
            let val =
                tokio::task::spawn_blocking(move || secrets::read_secret(&params.name)).await??;
            let plain = val.map(|z| z.to_string());
            Ok(serde_json::json!({ "value": plain }))
        }
        other => Err(anyhow!("Unknown RPC method: {other}")),
    }
}

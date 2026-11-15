use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use str0m::change::SdpOffer;
use str0m::format::Codec;
use str0m::media::{MediaKind, MediaTime, Mid};
use str0m::net::{Protocol, Receive, TcpType};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, Mutex};

use crate::h264::AnnexBStreamSplitter;
use crate::ifaces::{gather_srflx_addr_async, local_host_ips};
use crate::platform::{self, VideoFrame, VideoStreamHandle};
use crate::protocol::{
    parse_capture_target, CaptureTargetKind, RemoteInputEvent, StreamOfferParams, StreamOfferResult,
    StreamRetargetParams,
};

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

enum SessionCmd {
    Retarget(StreamRetargetParams),
    Close,
}

struct ActiveSession {
    cmd_tx: mpsc::Sender<SessionCmd>,
}

pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    input_enabled: Arc<AtomicBool>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            input_enabled: Arc::new(AtomicBool::new(true)),
        }
    }

    pub fn set_input_enabled(&self, enabled: bool) {
        self.input_enabled.store(enabled, Ordering::Relaxed);
    }

    pub async fn create_session(&self, params: StreamOfferParams) -> Result<StreamOfferResult> {
        let session_id = format!("s-{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
        let target = parse_capture_target(params.target.as_deref(), None);
        let fps = params.fps.unwrap_or(24).clamp(1, 60);
        let max_dim = params.max_dim.unwrap_or(1440).clamp(320, 3840);
        let bitrate = params.bitrate.unwrap_or(2_500_000).clamp(300_000, 12_000_000);
        let gather_timeout = Duration::from_millis(params.gather_timeout_ms.unwrap_or(1500).clamp(200, 5000));
        let idle_stop_ms = params.idle_stop_ms.unwrap_or(10_000).clamp(2000, 60_000);

        let udp4 = Arc::new(UdpSocket::bind("0.0.0.0:0").await?);
        let udp4_port = udp4.local_addr()?.port();

        let udp6 = UdpSocket::bind("[::]:0").await.ok().map(Arc::new);
        let udp6_port = udp6.as_ref().and_then(|s| s.local_addr().ok()).map(|a| a.port());

        let tcp_listener = TcpListener::bind("0.0.0.0:0").await.ok();
        let tcp_port = tcp_listener
            .as_ref()
            .and_then(|l| l.local_addr().ok())
            .map(|a| a.port());

        let mut rtc = Rtc::builder()
            .clear_codecs()
            .enable_h264(true)
            .build(Instant::now());

        let host_ips = local_host_ips();
        let mut primary_v4: Option<IpAddr> = None;
        for ip in &host_ips {
            match ip {
                IpAddr::V4(_) => {
                    if primary_v4.is_none() {
                        primary_v4 = Some(*ip);
                    }
                    if let Ok(cand) = Candidate::host(SocketAddr::new(*ip, udp4_port), Protocol::Udp) {
                        let _ = rtc.add_local_candidate(cand);
                    }
                    if let Some(tp) = tcp_port {
                        if let Ok(cand) = Candidate::builder()
                            .tcp()
                            .host(SocketAddr::new(*ip, tp))
                            .tcptype(TcpType::Passive)
                            .build()
                        {
                            let _ = rtc.add_local_candidate(cand);
                        }
                    }
                }
                IpAddr::V6(_) => {
                    if let Some(p6) = udp6_port {
                        if let Ok(cand) =
                            Candidate::host(SocketAddr::new(*ip, p6), Protocol::Udp)
                        {
                            let _ = rtc.add_local_candidate(cand);
                        }
                    }
                }
            }
        }

        // Non-trickle STUN srflx gathering when ice_servers are supplied
        if let Some(servers) = params.ice_servers.as_ref() {
            'stun: for srv in servers {
                for url in &srv.urls {
                    let Some(rest) = url.strip_prefix("stun:") else {
                        continue;
                    };
                    if let Some(srflx) =
                        gather_srflx_addr_async(&udp4, rest, gather_timeout).await
                    {
                        let base = SocketAddr::new(
                            primary_v4.unwrap_or_else(|| IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED)),
                            udp4_port,
                        );
                        if let Ok(cand) = Candidate::server_reflexive(srflx, base, Protocol::Udp) {
                            let _ = rtc.add_local_candidate(cand);
                        }
                        break 'stun;
                    }
                }
            }
        }

        let offer = SdpOffer::from_sdp_string(&params.sdp)
            .map_err(|e| anyhow!("Invalid SDP offer: {e}"))?;
        let answer = rtc
            .sdp_api()
            .accept_offer(offer)
            .map_err(|e| anyhow!("accept_offer failed: {e}"))?;
        let answer_sdp = answer.to_sdp_string();

        let (frame_tx, frame_rx) = mpsc::channel::<VideoFrame>(4);
        let (stream_source, backend) = if let Some(cmd) = params.ffmpeg_cmd.filter(|c| !c.is_empty()) {
            (start_ffmpeg_stream(&cmd, fps, frame_tx)?, "ffmpeg".to_string())
        } else {
            (
                StreamSource::Native(platform::start_video_stream(target, fps, max_dim, bitrate, frame_tx)?),
                platform::host_status().stream_backend,
            )
        };

        let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCmd>(8);
        {
            let mut map = self.sessions.lock().await;
            map.insert(
                session_id.clone(),
                ActiveSession {
                    cmd_tx: cmd_tx.clone(),
                },
            );
        }

        let sessions_ref = self.sessions.clone();
        let input_enabled_ref = self.input_enabled.clone();
        let sid_clone = session_id.clone();
        tokio::spawn(async move {
            run_session_loop(
                sid_clone.clone(),
                rtc,
                udp4,
                udp6,
                tcp_listener,
                stream_source,
                frame_rx,
                cmd_rx,
                Duration::from_millis(idle_stop_ms),
                input_enabled_ref,
            )
            .await;
            let mut map = sessions_ref.lock().await;
            map.remove(&sid_clone);
        });

        Ok(StreamOfferResult {
            sdp: answer_sdp,
            session: session_id,
            codec: "H264".to_string(),
            backend,
        })
    }

    pub async fn retarget_session(&self, params: StreamRetargetParams) -> Result<()> {
        let map = self.sessions.lock().await;
        let sess = map
            .get(&params.session)
            .ok_or_else(|| anyhow!("Unknown stream session: {}", params.session))?;
        sess.cmd_tx
            .send(SessionCmd::Retarget(params))
            .await
            .map_err(|_| anyhow!("Stream session closed"))?;
        Ok(())
    }

    pub async fn close_session(&self, session_id: &str) -> Result<bool> {
        let cmd_tx = {
            let mut map = self.sessions.lock().await;
            map.remove(session_id).map(|s| s.cmd_tx)
        };
        if let Some(tx) = cmd_tx {
            let _ = tx.send(SessionCmd::Close).await;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub async fn close_all(&self) {
        let items: Vec<mpsc::Sender<SessionCmd>> = {
            let mut map = self.sessions.lock().await;
            map.drain().map(|(_, v)| v.cmd_tx).collect()
        };
        for tx in items {
            let _ = tx.send(SessionCmd::Close).await;
        }
    }
}

enum StreamSource {
    Native(VideoStreamHandle),
    Ffmpeg(#[allow(dead_code)] FfmpegGuard),
}

impl StreamSource {
    fn request_keyframe(&self) {
        if let Self::Native(h) = self {
            h.request_keyframe();
        }
    }

    fn retarget(&self, target: CaptureTargetKind, fps: u32, max_dim: u32, bitrate: u32) -> Result<()> {
        match self {
            Self::Native(h) => h.retarget(target, fps, max_dim, bitrate),
            Self::Ffmpeg(_) => Ok(()),
        }
    }
}

struct FfmpegGuard {
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
}

impl Drop for FfmpegGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    }
}

fn start_ffmpeg_stream(
    cmd: &[String],
    fps: u32,
    tx: mpsc::Sender<VideoFrame>,
) -> Result<StreamSource> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let child = Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to spawn ffmpeg command: {}", cmd[0]))?;

    let child_arc = Arc::new(std::sync::Mutex::new(Some(child)));
    let stdout = child_arc
        .lock()
        .ok()
        .and_then(|mut g| g.as_mut().and_then(|c| c.stdout.take()))
        .ok_or_else(|| anyhow!("failed to open ffmpeg stdout"))?;

    let frame_step_us = 1_000_000u64 / fps.max(1) as u64;
    std::thread::Builder::new()
        .name("bot-host-ffmpeg".into())
        .spawn(move || {
            let mut reader = stdout;
            let mut splitter = AnnexBStreamSplitter::new();
            let mut buf = [0u8; 32 * 1024];
            let mut pts_us = 0u64;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        for (annexb, is_keyframe) in splitter.finish() {
                            let _ = tx.blocking_send(VideoFrame {
                                annexb,
                                pts_us,
                                is_keyframe,
                            });
                            pts_us += frame_step_us;
                        }
                        break;
                    }
                    Ok(n) => {
                        for (annexb, is_keyframe) in splitter.push(&buf[..n]) {
                            if tx
                                .blocking_send(VideoFrame {
                                    annexb,
                                    pts_us,
                                    is_keyframe,
                                })
                                .is_err()
                            {
                                return;
                            }
                            pts_us += frame_step_us;
                        }
                    }
                    Err(_) => break,
                }
            }
        })
        .context("failed to spawn ffmpeg reader thread")?;

    Ok(StreamSource::Ffmpeg(FfmpegGuard { child: child_arc }))
}

async fn run_session_loop(
    session_id: String,
    mut rtc: Rtc,
    udp4: Arc<UdpSocket>,
    udp6: Option<Arc<UdpSocket>>,
    tcp_listener: Option<TcpListener>,
    stream_handle: StreamSource,
    mut frame_rx: mpsc::Receiver<VideoFrame>,
    mut cmd_rx: mpsc::Receiver<SessionCmd>,
    idle_stop_timeout: Duration,
    input_enabled: Arc<AtomicBool>,
) {
    let mut video_mid: Option<Mid> = None;

    let (tcp_in_tx, mut tcp_in_rx) = mpsc::channel::<(SocketAddr, SocketAddr, Vec<u8>)>(64);
    let tcp_writers: Arc<Mutex<HashMap<SocketAddr, mpsc::Sender<Vec<u8>>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let tcp_accept_task = tcp_listener.map(|listener| {
        let tcp_in_tx = tcp_in_tx.clone();
        let tcp_writers = tcp_writers.clone();
        tokio::spawn(async move {
            let local_addr = match listener.local_addr() {
                Ok(a) => a,
                Err(_) => return,
            };
            loop {
                let Ok((stream, peer_addr)) = listener.accept().await else {
                    break;
                };
                let tx_in = tcp_in_tx.clone();
                let writers = tcp_writers.clone();
                tokio::spawn(async move {
                    handle_ice_tcp_conn(stream, peer_addr, local_addr, tx_in, writers).await;
                });
            }
        })
    });

    let mut udp4_buf = vec![0u8; 4096];
    let mut udp6_buf = vec![0u8; 4096];
    let mut last_connected = Instant::now();
    let mut ever_connected = false;
    let mut ice_connected = false;
    let idle_grace = Duration::from_secs(15);

    loop {
        if !rtc.is_alive() {
            break;
        }
        if !ever_connected && last_connected.elapsed() > idle_grace {
            tracing::debug!("session {session_id} ICE connect timeout");
            break;
        }
        if ever_connected && !ice_connected && last_connected.elapsed() > idle_stop_timeout {
            tracing::debug!("session {session_id} ICE disconnected > {idle_stop_timeout:?}, stopping");
            break;
        }

        let next_timeout = loop {
            match rtc.poll_output() {
                Ok(Output::Timeout(t)) => break t,
                Ok(Output::Transmit(t)) => {
                    match t.proto {
                        Protocol::Udp => {
                            if t.destination.is_ipv4() {
                                let _ = udp4.send_to(&t.contents, t.destination).await;
                            } else if let Some(ref s6) = udp6 {
                                let _ = s6.send_to(&t.contents, t.destination).await;
                            }
                        }
                        Protocol::Tcp | Protocol::SslTcp | Protocol::Tls => {
                            let guard = tcp_writers.lock().await;
                            if let Some(wtx) = guard.get(&t.destination) {
                                let _ = wtx.try_send(t.contents.to_vec());
                            }
                        }
                    }
                }
                Ok(Output::Event(ev)) => match ev {
                    Event::IceConnectionStateChange(state) => {
                        match state {
                            IceConnectionState::Connected | IceConnectionState::Completed => {
                                ever_connected = true;
                                ice_connected = true;
                                last_connected = Instant::now();
                                stream_handle.request_keyframe();
                            }
                            IceConnectionState::Disconnected => {
                                ice_connected = false;
                                if !ever_connected {
                                    last_connected = Instant::now();
                                }
                            }
                            _ => {}
                        }
                    }
                    Event::Connected => {
                        ever_connected = true;
                        ice_connected = true;
                        last_connected = Instant::now();
                        stream_handle.request_keyframe();
                    }
                    Event::MediaAdded(ma) => {
                        if ma.kind == MediaKind::Video {
                            video_mid = Some(ma.mid);
                        }
                    }
                    Event::KeyframeRequest(_) => {
                        stream_handle.request_keyframe();
                    }
                    Event::ChannelData(cd) => {
                        if input_enabled.load(Ordering::Relaxed) {
                            if let Ok(text) = std::str::from_utf8(&cd.data) {
                                if let Ok(ev) = serde_json::from_str::<RemoteInputEvent>(text) {
                                    if let Err(err) = platform::inject_input(&ev) {
                                        tracing::debug!("DataChannel input error: {err}");
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                },
                Err(err) => {
                    tracing::debug!("rtc.poll_output error in {session_id}: {err}");
                    rtc.disconnect();
                    break Instant::now() + Duration::from_millis(10);
                }
            }
        };

        if !rtc.is_alive() {
            break;
        }
        if ice_connected {
            last_connected = Instant::now();
        }

        let sleep_dur = next_timeout
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));

        tokio::select! {
            _ = tokio::time::sleep(sleep_dur) => {
                let _ = rtc.handle_input(Input::Timeout(Instant::now()));
            }
            res = udp4.recv_from(&mut udp4_buf) => {
                if let Ok((n, src)) = res {
                    if let Ok(dst) = udp4.local_addr() {
                        if let Ok(recv) = Receive::new(Protocol::Udp, src, dst, &udp4_buf[..n]) {
                            let _ = rtc.handle_input(Input::Receive(Instant::now(), recv));
                        }
                    }
                }
            }
            res = async {
                match udp6.as_ref() {
                    Some(s6) => s6.recv_from(&mut udp6_buf).await,
                    None => std::future::pending().await,
                }
            } => {
                if let Ok((n, src)) = res {
                    if let Some(dst) = udp6.as_ref().and_then(|s| s.local_addr().ok()) {
                        if let Ok(recv) = Receive::new(Protocol::Udp, src, dst, &udp6_buf[..n]) {
                            let _ = rtc.handle_input(Input::Receive(Instant::now(), recv));
                        }
                    }
                }
            }
            Some((src, dst, payload)) = tcp_in_rx.recv() => {
                if let Ok(recv) = Receive::new(Protocol::Tcp, src, dst, &payload) {
                    let _ = rtc.handle_input(Input::Receive(Instant::now(), recv));
                }
            }
            Some(frame) = frame_rx.recv() => {
                if let Some(mid) = video_mid {
                    if let Some(writer) = rtc.writer(mid) {
                        let pt_opt = writer
                            .payload_params()
                            .find(|p| p.spec().codec == Codec::H264)
                            .map(|p| p.pt());
                        if let Some(pt) = pt_opt {
                            let mtime = MediaTime::from_90khz((frame.pts_us * 9) / 100);
                            if let Err(err) = writer.write(pt, Instant::now(), mtime, frame.annexb) {
                                tracing::debug!("str0m writer.write error: {err}");
                            }
                        }
                    }
                }
            }
            Some(cmd) = cmd_rx.recv() => {
                match cmd {
                    SessionCmd::Retarget(p) => {
                        let tgt = parse_capture_target(p.target.as_deref(), None);
                        let _ = stream_handle.retarget(
                            tgt,
                            p.fps.unwrap_or(24).clamp(1, 60),
                            p.max_dim.unwrap_or(1440).clamp(320, 3840),
                            p.bitrate.unwrap_or(2_500_000).clamp(300_000, 12_000_000),
                        );
                    }
                    SessionCmd::Close => {
                        rtc.disconnect();
                        break;
                    }
                }
            }
        }
    }

    if let Some(task) = tcp_accept_task {
        task.abort();
    }
}

async fn handle_ice_tcp_conn(
    stream: TcpStream,
    peer_addr: SocketAddr,
    local_addr: SocketAddr,
    in_tx: mpsc::Sender<(SocketAddr, SocketAddr, Vec<u8>)>,
    writers: Arc<Mutex<HashMap<SocketAddr, mpsc::Sender<Vec<u8>>>>>,
) {
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    {
        let mut guard = writers.lock().await;
        guard.insert(peer_addr, out_tx);
    }

    let write_task = tokio::spawn(async move {
        while let Some(pkt) = out_rx.recv().await {
            if pkt.len() > u16::MAX as usize {
                continue;
            }
            let len_be = (pkt.len() as u16).to_be_bytes();
            if wr.write_all(&len_be).await.is_err() || wr.write_all(&pkt).await.is_err() {
                break;
            }
        }
    });

    let mut len_buf = [0u8; 2];
    while rd.read_exact(&mut len_buf).await.is_ok() {
        let frame_len = u16::from_be_bytes(len_buf) as usize;
        if frame_len == 0 || frame_len > 65535 {
            break;
        }
        let mut buf = vec![0u8; frame_len];
        if rd.read_exact(&mut buf).await.is_err() {
            break;
        }
        if in_tx.send((peer_addr, local_addr, buf)).await.is_err() {
            break;
        }
    }

    write_task.abort();
    let mut guard = writers.lock().await;
    guard.remove(&peer_addr);
}

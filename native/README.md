# Native Host (`bot-host`)

`native/bot-host` is a single Rust binary that replaces the previous Go WebRTC sidecar (`bot-stream`), Swift capture helper (`bot-capture`), and platform shell wrappers (`security`, `screencapture`, `sips`, `caffeinate`, `pbcopy`).

Built locally into `dist/bin/bot-host-<platform>-<arch>[.exe]` via `npm run build:native`, or downloaded automatically from the matching GitHub Release (`SHA256SUMS.txt` verified) into the user cache directory during `postinstall` / first RPC call.

## Architecture

- **Protocol**: persistent stdio JSON-RPC (`bot-host --stdio`) plus CLI flags (`--version`, `--status`, `--list-displays`, `--list-windows`).
- **WebRTC (`str0m`)**: pure Rust ICE/DTLS/SRTP/SCTP peer connection, single H.264 video track (`profile-level-id=42e01f`), `"input"` DataChannel, RTCP PLI/FIR keyframe requests, non-trickle ICE (UDP4/UDP6 + RFC 4571 ICE-TCP passive + STUN), and virtual-NIC / fake-IP filtering.
- **Platform Backends**:
  - **macOS (`platform/macos.rs`)**: `ScreenCaptureKit` (`SCShareableContent`, `SCScreenshotManager`, `SCStream`) + `VideoToolbox` H.264 Constrained Baseline low-latency hardware encode + `CGEvent` mouse/pixel-wheel/key/UTF-16 injection + `IOPMAssertionCreateWithName` keep-awake + `Security.framework` / `keyring` Keychain (`opencode-bot` double-hex compatible).
  - **Windows (`platform/windows.rs`)**: `EnumDisplayMonitors` + `EnumWindows` + GDI `BitBlt` capture + `OpenH264` Constrained Baseline encoding + `SendInput` (`MOUSEEVENTF_VIRTUALDESK`, `KEYEVENTF_UNICODE`) + `SetThreadExecutionState` keep-awake + Windows Credential Manager (`keyring`).
  - **Linux (`platform/linux.rs`)**: `x11rb` (`RANDR` displays, `_NET_CLIENT_LIST` windows, `GetImage` capture, `XTEST` input + `xdotool` text fallback) + `OpenH264` encoding + D-Bus `org.freedesktop.ScreenSaver.Inhibit` keep-awake + Secret Service (`keyring`).
- **FFmpeg Pipe Mode**: if `stream.offer` receives `ffmpegCmd`, `bot-host` spawns that command, splits its raw Annex-B stdout via `AnnexBStreamSplitter`, and streams it through the same `str0m` WebRTC stack.

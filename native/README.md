# Native live-stream helpers

Built into `dist/bin` by `npm run build:native` (needs Go; on macOS also Swift).

| Binary | Language | Role |
|---|---|---|
| `bot-stream-<platform>-<arch>` | Go + pion/webrtc | WebRTC peer, one shared H.264 track for all viewers, input DataChannel. Platform-independent. |
| `bot-capture-<platform>-<arch>` | per platform | Screen capture + hardware H.264 encode + input injection. |

The plugin talks to `bot-stream` over stdin/stdout JSON lines (`offer` → `answer`, `close`);
signaling travels over the plugin RPC (`streamOffer` / `streamClose`), so it works wherever the
OpenCode server is reachable. Media goes peer-to-peer.

## Capture backends

`bot-stream --capture <binary>` runs the framed contract below (native backend,
macOS: hardware encode + input injection). `bot-stream --raw-cmd '<JSON argv>'`
runs any command that writes raw H.264 Annex-B to stdout (raw backend, e.g.
`ffmpeg -f h264 ... pipe:1`); the sidecar re-frames the NAL stream itself and
synthesizes timestamps from `--fps`. The raw backend is **view-only**: there is
no stdin contract, so DataChannel input events are dropped (input injection
still works through the agent-desktop RPC fallback).

Adding Windows/Linux the quick way: install ffmpeg and rely on the raw backend
(`streamBackend: "ffmpeg"` or auto). The full way: write another `bot-capture`
that honours this contract:

- args: `--fps N --bitrate BPS --max-dim PX --display I`
- stdout: `[u32 BE length][u64 BE pts µs][u8 flags, 1 = keyframe][H.264 Annex-B, constrained baseline, SPS/PPS before keyframes]`
- stdin JSON lines: `{"t":"key"}`, `{"t":"bitrate","v":bps}`, and input
  `{"t":"move"|"down"|"up","x":0..1,"y":0..1,"b":0|1|2,shift,ctrl,alt,meta}`,
  `{"t":"wheel","dx","dy"}` (pixels), `{"t":"keydown"|"keyup","code":KeyboardEvent.code,...mods}`, `{"t":"text","s":"..."}`
- stderr JSON lines: `{"t":"ready","width","height"}` / `{"t":"error","message"}`
- exit when stdin closes

Planned native backends (beyond the ffmpeg raw backend): Windows
(Desktop Duplication + Media Foundation H.264 + SendInput),
Linux (PipeWire portal + VA-API/x264 + uinput/libei).

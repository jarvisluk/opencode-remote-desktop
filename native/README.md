# Native live-stream helpers

Built into `dist/bin` by `npm run build:native` (needs Go; on macOS also Swift).

| Binary | Language | Role |
|---|---|---|
| `bot-stream-<platform>-<arch>` | Go + pion/webrtc | WebRTC peer, one shared H.264 track for all viewers, input DataChannel. Platform-independent. |
| `bot-capture-<platform>-<arch>` | per platform | Screen capture + hardware H.264 encode + input injection. |

The plugin talks to `bot-stream` over stdin/stdout JSON lines (`offer` → `answer`, `close`);
signaling travels over the plugin RPC (`streamOffer` / `streamClose`), so it works wherever the
OpenCode server is reachable. Media goes peer-to-peer.

## Capture backend contract

Adding Windows/Linux only means writing another `bot-capture` that honours this contract:

- args: `--fps N --bitrate BPS --max-dim PX --display I`
- stdout: `[u32 BE length][u64 BE pts µs][u8 flags, 1 = keyframe][H.264 Annex-B, constrained baseline, SPS/PPS before keyframes]`
- stdin JSON lines: `{"t":"key"}`, `{"t":"bitrate","v":bps}`, and input
  `{"t":"move"|"down"|"up","x":0..1,"y":0..1,"b":0|1|2,shift,ctrl,alt,meta}`,
  `{"t":"wheel","dx","dy"}` (pixels), `{"t":"keydown"|"keyup","code":KeyboardEvent.code,...mods}`, `{"t":"text","s":"..."}`
- stderr JSON lines: `{"t":"ready","width","height"}` / `{"t":"error","message"}`
- exit when stdin closes

Planned backends: Windows (Desktop Duplication + Media Foundation H.264 + SendInput),
Linux (PipeWire portal + VA-API/x264 + uinput/libei).

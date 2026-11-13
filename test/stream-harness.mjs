// Manual end-to-end harness: node test/stream-harness.mjs, then open http://127.0.0.1:8787
// BOT_RAW=1 node test/stream-harness.mjs uses the ffmpeg raw backend (lavfi testsrc) instead.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin")
const tag = `${process.platform}-${process.arch}`
const rawArgs = [
  "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=30",
  "-vf", "scale='if(gt(iw,ih),min(iw,1920),-2)':'if(gt(iw,ih),-2,min(ih,1920))'",
  "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
  "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "60",
  "-b:v", "4000000", "-maxrate", "4000000", "-bufsize", "8000000",
  "-an", "-f", "h264", "-nostdin", "-loglevel", "error", "pipe:1",
]
const sidecarArgs = process.env.BOT_RAW === "1"
  ? ["--raw-cmd", JSON.stringify(["ffmpeg", ...rawArgs]), "--fps", "30"]
  : ["--capture", path.join(bin, `bot-capture-${tag}`)]
const sidecar = spawn(path.join(bin, `bot-stream-${tag}`), sidecarArgs, {
  stdio: ["pipe", "pipe", "inherit"],
})
const pending = new Map()
let nextId = 1
createInterface({ input: sidecar.stdout }).on("line", (line) => {
  const msg = JSON.parse(line)
  pending.get(msg.id)?.(msg)
  pending.delete(msg.id)
})
const request = (msg) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    sidecar.stdin.write(JSON.stringify({ ...msg, id }) + "\n")
  })

const page = `<!doctype html><body style="margin:0;background:#000;color:#fff;font:12px system-ui">
<div id=s>connecting</div><video id=v autoplay muted playsinline style="width:100vw;height:90vh;object-fit:contain"></video>
<script>
const pc = new RTCPeerConnection();
pc.addTransceiver("video", { direction: "recvonly" });
pc.createDataChannel("input");
pc.ontrack = (e) => { v.srcObject = new MediaStream([e.track]); };
let t0 = performance.now(), lastBytes = 0, lastFrames = 0;
window.result = { state: "new" };
pc.onconnectionstatechange = () => { window.result.state = pc.connectionState; window.result.connectMs = Math.round(performance.now() - t0); };
(async () => {
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => { pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && r(); setTimeout(r, 2000); });
  const res = await fetch("/offer", { method: "POST", body: pc.localDescription.sdp }).then((r) => r.json());
  await pc.setRemoteDescription({ type: "answer", sdp: res.sdp });
  setInterval(async () => {
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp" && r.kind === "video") {
        Object.assign(window.result, { fps: r.framesDecoded - lastFrames, kbps: Math.round((r.bytesReceived - lastBytes) * 8 / 1000),
          decoded: r.framesDecoded, codec: r.decoderImplementation, w: r.frameWidth, h: r.frameHeight, jitterMs: Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) });
        lastFrames = r.framesDecoded; lastBytes = r.bytesReceived;
      }
    });
    s.textContent = JSON.stringify(window.result);
  }, 1000);
})();
</script>`

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/offer") {
    let body = ""
    for await (const c of req) body += c
    const answer = await request({ t: "offer", sdp: body })
    res.setHeader("content-type", "application/json")
    return res.end(JSON.stringify(answer))
  }
  res.setHeader("content-type", "text/html")
  res.end(page)
}).listen(8787, "127.0.0.1", () => console.log("harness on http://127.0.0.1:8787"))

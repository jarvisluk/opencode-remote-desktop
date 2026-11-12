// Manual end-to-end harness: node test/stream-harness.mjs, then open http://127.0.0.1:8787
// Bridges a browser page to the dotbot-stream sidecar without OpenCode in the loop.
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin")
const tag = `${process.platform}-${process.arch}`
const sidecar = spawn(path.join(bin, `dotbot-stream-${tag}`), ["--capture", path.join(bin, `dotbot-capture-${tag}`)], {
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

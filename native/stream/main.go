// bot-stream: cross-platform WebRTC sidecar.
//
// It spawns the platform capture helper (bot-capture-<os>-<arch>), packetizes its H.264
// output into a WebRTC video track and forwards DataChannel input events back to the helper.
// Signaling happens over stdin/stdout JSON lines with the OpenCode plugin process:
//
//	in:  {"id":1,"t":"offer","sdp":"..."}       out: {"id":1,"t":"answer","sdp":"...","session":"..."}
//	in:  {"id":2,"t":"close","session":"..."}   out: {"id":2,"t":"ok"}
//	                                             out: {"id":n,"t":"error","message":"..."}
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

var (
	capturePath = flag.String("capture", "", "path to the native capture helper (framed contract)")
	rawCmd      = flag.String("raw-cmd", "", "JSON array: command emitting raw H.264 Annex-B on stdout (e.g. ffmpeg)")
	iceServers  = flag.String("ice", "", "comma-separated STUN/TURN URLs (empty = LAN/host candidates only)")
	fps         = flag.Int("fps", 30, "capture frame rate")
	bitrate     = flag.Int("bitrate", 4_000_000, "initial video bitrate (bps)")
	maxDim      = flag.Int("max-dim", 1920, "longest edge of the encoded video")
	idleStop    = flag.Duration("idle-stop", 10*time.Second, "stop capture after the last viewer leaves")
)

type request struct {
	ID      int64  `json:"id"`
	T       string `json:"t"`
	SDP     string `json:"sdp,omitempty"`
	Session string `json:"session,omitempty"`
	Enabled bool   `json:"enabled,omitempty"`
}

// inputEnabled is cleared by the plugin while an agent owns the screen, so viewers cannot fight it.
var inputEnabled atomic.Bool

var (
	outMu sync.Mutex
	out   = json.NewEncoder(os.Stdout)
)

func reply(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = out.Encode(v)
}

// Allowed input message types; anything else from a viewer is dropped.
var inputTypes = map[string]bool{"move": true, "down": true, "up": true, "wheel": true, "keydown": true, "keyup": true, "text": true}

func main() {
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("[bot-stream] ")
	inputEnabled.Store(true)
	if *capturePath == "" && *rawCmd == "" {
		log.Fatal("--capture or --raw-cmd is required")
	}

	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{
		MimeType:    webrtc.MimeTypeH264,
		ClockRate:   90000,
		SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
	}, "video", "bot-screen")
	if err != nil {
		log.Fatal(err)
	}
	hub := &hub{track: track, peers: map[string]*webrtc.PeerConnection{}}

	var servers []webrtc.ICEServer
	for _, u := range strings.Split(*iceServers, ",") {
		if u = strings.TrimSpace(u); u != "" {
			servers = append(servers, webrtc.ICEServer{URLs: []string{u}})
		}
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings()))

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var req request
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		switch req.T {
		case "offer":
			go func(req request) {
				session, answer, err := hub.accept(api, servers, req.SDP)
				if err != nil {
					reply(map[string]any{"id": req.ID, "t": "error", "message": err.Error()})
					return
				}
				reply(map[string]any{"id": req.ID, "t": "answer", "sdp": answer, "session": session})
			}(req)
		case "close":
			hub.remove(req.Session)
			reply(map[string]any{"id": req.ID, "t": "ok"})
		case "input":
			inputEnabled.Store(req.Enabled)
			reply(map[string]any{"id": req.ID, "t": "ok"})
		}
	}
	// stdin closed: the plugin is gone.
	hub.stopCapture()
}

// settings drops host candidates no viewer can reach: 198.18.0.0/15 & fdfe:dcba:9876::/48 (proxy TUN fake-ip),
// link-local addresses, and Apple/virtual interfaces (awdl, llw, anpi, bridge, vmenet, ap, gif, stf).
var (
	_, fakeIPNet, _  = net.ParseCIDR("198.18.0.0/15")
	_, fakeIP6Net, _ = net.ParseCIDR("fdfe:dcba:9876::/48")
)

func isAllowedInterface(name string) bool {
	for _, prefix := range []string{"awdl", "llw", "anpi", "bridge", "vmenet", "ap", "gif", "stf"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}

func isAllowedIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if fakeIPNet != nil && fakeIPNet.Contains(ip) {
		return false
	}
	if fakeIP6Net != nil && fakeIP6Net.Contains(ip) {
		return false
	}
	return true
}

var initTCPMux = sync.OnceValue(func() func(*webrtc.SettingEngine) {
	ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return func(*webrtc.SettingEngine) {}
	}
	tm := webrtc.NewICETCPMux(nil, ln, 8)
	return func(s *webrtc.SettingEngine) {
		s.SetICETCPMux(tm)
		s.SetNetworkTypes([]webrtc.NetworkType{
			webrtc.NetworkTypeUDP4,
			webrtc.NetworkTypeUDP6,
			webrtc.NetworkTypeTCP4,
		})
	}
})

func settings() webrtc.SettingEngine {
	var s webrtc.SettingEngine
	s.SetInterfaceFilter(isAllowedInterface)
	s.SetIPFilter(isAllowedIP)
	initTCPMux()(&s)
	return s
}

type hub struct {
	mu        sync.Mutex
	track     *webrtc.TrackLocalStaticSample
	peers     map[string]*webrtc.PeerConnection
	capture   *exec.Cmd
	capIn     io.WriteCloser
	capInMu   sync.Mutex
	capInBuf  []byte
	idleTimer *time.Timer
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *hub) accept(api *webrtc.API, servers []webrtc.ICEServer, offerSDP string) (string, string, error) {
	pc, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return "", "", err
	}
	id := newID()
	fail := func(err error) (string, string, error) {
		_ = pc.Close()
		h.mu.Lock()
		h.scheduleIdleLocked()
		h.mu.Unlock()
		return "", "", err
	}

	sender, err := pc.AddTrack(h.track)
	if err != nil {
		return fail(err)
	}
	go func() {
		for {
			pkts, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, p := range pkts {
				switch p.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					h.send(`{"t":"key"}`)
				}
			}
		}
	}()

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			var probe struct {
				T string `json:"t"`
			}
			if inputEnabled.Load() && msg.IsString && len(msg.Data) < 8192 && json.Unmarshal(msg.Data, &probe) == nil && inputTypes[probe.T] {
				h.sendBytes(msg.Data)
			}
		})
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("peer %s: %s", id, s)
		switch s {
		case webrtc.PeerConnectionStateConnected:
			h.send(`{"t":"key"}`)
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			h.remove(id)
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return fail(err)
	}
	// Pre-warm capture in parallel with answer creation & ICE gathering so the first keyframe is ready on connect.
	if err := h.ensureCapture(); err != nil {
		return fail(err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(err)
	}
	// Non-trickle: one RPC round trip carries every candidate. Unreachable STUN must not stall signaling.
	gatherTimeout := 1500 * time.Millisecond
	if len(servers) > 0 {
		gatherTimeout = 3 * time.Second
	}
	select {
	case <-gathered:
	case <-time.After(gatherTimeout):
	}

	h.mu.Lock()
	h.peers[id] = pc
	if h.idleTimer != nil {
		h.idleTimer.Stop()
		h.idleTimer = nil
	}
	h.mu.Unlock()
	return id, pc.LocalDescription().SDP, nil
}

func (h *hub) scheduleIdleLocked() {
	if len(h.peers) == 0 && h.capture != nil && h.idleTimer == nil {
		h.idleTimer = time.AfterFunc(*idleStop, func() {
			h.mu.Lock()
			idle := len(h.peers) == 0
			h.idleTimer = nil
			h.mu.Unlock()
			if idle {
				h.stopCapture()
			}
		})
	}
}

func (h *hub) remove(id string) {
	h.mu.Lock()
	pc, ok := h.peers[id]
	delete(h.peers, id)
	h.scheduleIdleLocked()
	h.mu.Unlock()
	if ok {
		_ = pc.Close()
	}
}

func (h *hub) send(line string) {
	h.capInMu.Lock()
	defer h.capInMu.Unlock()
	if h.capIn != nil {
		h.capInBuf = append(h.capInBuf[:0], line...)
		h.capInBuf = append(h.capInBuf, '\n')
		_, _ = h.capIn.Write(h.capInBuf)
	}
}

func (h *hub) sendBytes(data []byte) {
	h.capInMu.Lock()
	defer h.capInMu.Unlock()
	if h.capIn != nil {
		h.capInBuf = append(h.capInBuf[:0], data...)
		h.capInBuf = append(h.capInBuf, '\n')
		_, _ = h.capIn.Write(h.capInBuf)
	}
}

func (h *hub) ensureCapture() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.idleTimer != nil {
		h.idleTimer.Stop()
		h.idleTimer = nil
	}
	if h.capture != nil {
		return nil
	}
	if *rawCmd != "" {
		return h.startRaw()
	}
	return h.startNative()
}

// startRaw spawns the --raw-cmd producer (e.g. ffmpeg -f h264 pipe:1) and
// reframes its Annex-B byte stream into track samples. View-only: raw producers
// have no stdin contract, so DataChannel input events are dropped.
func (h *hub) startRaw() error {
	var argv []string
	if json.Unmarshal([]byte(*rawCmd), &argv) != nil || len(argv) == 0 {
		return fmt.Errorf("--raw-cmd must be a JSON array of argv strings")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	h.capture = cmd
	go h.pumpRaw(cmd, stdout)
	return nil
}

func (h *hub) startNative() error {
	cmd := exec.Command(*capturePath,
		"--fps", fmt.Sprint(*fps), "--bitrate", fmt.Sprint(*bitrate), "--max-dim", fmt.Sprint(*maxDim))
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	h.capture = cmd
	h.capInMu.Lock()
	h.capIn = stdin
	h.capInMu.Unlock()
	go h.pump(cmd, stdout)
	return nil
}

func (h *hub) stopCapture() {
	h.mu.Lock()
	cmd := h.capture
	h.capture = nil
	h.mu.Unlock()
	h.capInMu.Lock()
	if h.capIn != nil {
		_ = h.capIn.Close()
		h.capIn = nil
	}
	h.capInMu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

// pump reads [u32 len][u64 pts µs][u8 flags][Annex-B] frames and feeds the shared track.
func (h *hub) pump(cmd *exec.Cmd, r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	header := make([]byte, 13)
	const maxPooledFrame = 2 << 20
	scratch := make([]byte, 256<<10)
	var lastPts uint64
	for {
		if _, err := io.ReadFull(br, header); err != nil {
			break
		}
		n := binary.BigEndian.Uint32(header[0:4])
		pts := binary.BigEndian.Uint64(header[4:12])
		if n > 16<<20 {
			log.Printf("bad frame length %d", n)
			break
		}
		var buf []byte
		if int(n) <= maxPooledFrame {
			if cap(scratch) < int(n) {
				scratch = make([]byte, int(n))
			}
			buf = scratch[:int(n)]
		} else {
			buf = make([]byte, int(n))
		}
		if _, err := io.ReadFull(br, buf); err != nil {
			break
		}
		dur := time.Second / time.Duration(*fps)
		if lastPts != 0 && pts > lastPts {
			dur = time.Duration(pts-lastPts) * time.Microsecond
		}
		lastPts = pts
		_ = h.track.WriteSample(media.Sample{Data: buf, Duration: dur})
	}
	h.captureDone(cmd)
}

// pumpRaw reframes a raw Annex-B byte stream (no headers, no timestamps) into samples.
func (h *hub) pumpRaw(cmd *exec.Cmd, r io.Reader) {
	parser := newAnnexbParser(*fps)
	buf := make([]byte, 64<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			for _, s := range parser.feed(buf[:n]) {
				_ = h.track.WriteSample(s)
			}
		}
		if err != nil {
			break
		}
	}
	for _, s := range parser.final() {
		_ = h.track.WriteSample(s)
	}
	h.captureDone(cmd)
}

func (h *hub) captureDone(cmd *exec.Cmd) {
	err := cmd.Wait()
	h.mu.Lock()
	if h.capture == cmd {
		h.capture = nil
	}
	h.mu.Unlock()
	log.Printf("capture exited: %v", err)
}

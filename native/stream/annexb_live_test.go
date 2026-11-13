package main

import (
	"bytes"
	"os/exec"
	"testing"
	"time"
)

// Live integration test: feeds real ffmpeg output through the parser.
// Skipped when ffmpeg is not on PATH (e.g. CI without it).
func TestParseLiveFfmpegOutput(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not found on PATH")
	}
	cmd := exec.Command(ffmpeg,
		"-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
		"-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "30",
		"-an", "-f", "h264", "-nostdin", "-loglevel", "error", "pipe:1")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("ffmpeg failed to start: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	p := newAnnexbParser(30)
	buf := make([]byte, 32<<10)
	done := make(chan struct{})
	var frames int
	var first []byte
	go func() {
		defer close(done)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				samples := p.feed(buf[:n])
				if len(samples) > 0 && first == nil {
					first = append([]byte{}, samples[0].Data...)
				}
				frames += len(samples)
			}
			if err != nil {
				frames += len(p.final())
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}

	// 30fps source, ~5s window: expect well over 60 complete frames.
	if frames < 60 {
		t.Fatalf("want >=60 frames parsed from live ffmpeg output, got %d", frames)
	}
	// x264 emits SPS+PPS+SEI+IDR for the first frame: must start with a start code.
	if !bytes.HasPrefix(first, []byte{0, 0, 0, 1}) {
		t.Fatalf("first sample should start with an Annex-B start code, got % x", first[:min(8, len(first))])
	}
}

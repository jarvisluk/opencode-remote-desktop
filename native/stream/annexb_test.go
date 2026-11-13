package main

import (
	"bytes"
	"testing"
	"time"
)

// nal builds an Annex-B NAL unit: 4-byte start code + 1-byte header + payload.
func nal(header byte, payload ...byte) []byte {
	out := []byte{0, 0, 0, 1, header}
	return append(out, payload...)
}

func sps() []byte   { return nal(0x67, 0x42, 0xC0) }  // type 7
func pps() []byte   { return nal(0x68, 0xE9) }        // type 8
func idr() []byte   { return nal(0x65, 0x88, 0x84) }  // type 5 (IDR slice)
func slice() []byte { return nal(0x41, 0x9A, 0x22) }  // type 1 (non-IDR slice)
func aud() []byte   { return nal(0x09, 0x10) }        // type 9

func keyframe() []byte { return append(append(append([]byte{}, sps()...), pps()...), idr()...) }
func pframe() []byte   { return append([]byte{}, slice()...) }

func TestSplitFramesWithoutAUD(t *testing.T) {
	p := newAnnexbParser(30)
	stream := append(append(keyframe(), pframe()...), pframe()...)
	// Frames open on the *next* frame's first NAL, so the last one needs final().
	samples := p.feed(stream)
	if len(samples) != 1 {
		t.Fatalf("feed should emit 1 sample (the last NAL stays buffered), got %d", len(samples))
	}
	samples = append(samples, p.final()...)
	if len(samples) != 3 {
		t.Fatalf("final should flush the last frame; want 3 total, got %d", len(samples))
	}
	if !bytes.HasPrefix(samples[0].Data, []byte{0, 0, 0, 1, 0x67}) {
		t.Errorf("first sample should start with SPS, got % x", samples[0].Data[:8])
	}
	if !bytes.Contains(samples[0].Data, []byte{0x65, 0x88, 0x84}) {
		t.Errorf("keyframe sample should contain the IDR slice")
	}
	if samples[0].Duration != time.Second/30 {
		t.Errorf("duration should be 1/fps, got %v", samples[0].Duration)
	}
}

func TestSplitFramesWithAUD(t *testing.T) {
	p := newAnnexbParser(10)
	// x264-style: AUD + SPS + PPS + slice per frame.
	frame := func() []byte { return append(append(append(append([]byte{}, aud()...), sps()...), pps()...), slice()...) }
	samples := p.feed(append(append(frame(), frame()...), frame()...))
	samples = append(samples, p.final()...)
	if len(samples) != 3 {
		t.Fatalf("want 3 samples, got %d", len(samples))
	}
	for i, s := range samples {
		if !bytes.HasPrefix(s.Data, []byte{0, 0, 0, 1, 0x09}) {
			t.Errorf("AUD should open frame %d, got % x", i, s.Data[:6])
		}
	}
}

func TestSplitStartCodeAcrossFeeds(t *testing.T) {
	p := newAnnexbParser(30)
	stream := append(keyframe(), pframe()...)
	// Split mid start code: the 00 00 00 01 of the P-frame straddles the feeds.
	cut := len(keyframe()) + 2
	if got := p.feed(stream[:cut]); len(got) != 0 {
		t.Fatalf("keyframe stays buffered until the next frame opens it; got %d samples", len(got))
	}
	got := p.feed(stream[cut:])
	got = append(got, p.final()...)
	if len(got) != 2 {
		t.Fatalf("want keyframe + P-frame across the remaining feeds, got %d", len(got))
	}
	if !bytes.Contains(got[0].Data, []byte{0x65, 0x88, 0x84}) {
		t.Errorf("first sample should be the keyframe")
	}
	if !bytes.HasPrefix(got[1].Data, []byte{0, 0, 0, 1, 0x41}) {
		t.Errorf("P-frame sample should start with a type-1 slice, got % x", got[1].Data[:6])
	}
}

func TestByteAtATimeFeed(t *testing.T) {
	p := newAnnexbParser(25)
	stream := append(append(keyframe(), pframe()...), keyframe()...)
	var total int
	for i := range stream {
		total += len(p.feed(stream[i : i+1]))
	}
	total += len(p.final())
	if total != 3 {
		t.Fatalf("want 3 samples across byte-by-byte feeds + final, got %d", total)
	}
}

func TestSEIAfterSliceOpensNewFrame(t *testing.T) {
	p := newAnnexbParser(30)
	// slice + SEI (SEI after a slice opens the next frame).
	stream := append(append(append([]byte{}, idr()...), nal(0x06, 0x01)...), slice()...)
	samples := append(p.feed(stream), p.final()...)
	if len(samples) != 2 {
		t.Fatalf("SEI after a slice should open a new frame; want 2 samples, got %d", len(samples))
	}
	if !bytes.Contains(samples[1].Data, []byte{0x41, 0x9A, 0x22}) {
		t.Errorf("second frame should contain the trailing slice")
	}
}

func TestNonVCLOnlyInputEmitsNothing(t *testing.T) {
	p := newAnnexbParser(30)
	samples := append(p.feed(append(sps(), pps()...)), p.final()...)
	if len(samples) != 0 {
		t.Fatalf("parameter sets alone must not emit a frame, got %d", len(samples))
	}
}

func TestFindStartCodePrefersFourByte(t *testing.T) {
	if off, l := findStartCode([]byte{0x55, 0, 0, 0, 1, 0x67}); off != 1 || l != 4 {
		t.Fatalf("want offset 1 len 4, got %d %d", off, l)
	}
	if off, l := findStartCode([]byte{0x55, 0, 0, 1, 0x67}); off != 1 || l != 3 {
		t.Fatalf("want offset 1 len 3, got %d %d", off, l)
	}
	if off, _ := findStartCode([]byte{0, 0}); off != -1 {
		t.Fatalf("no start code, want -1, got %d", off)
	}
}

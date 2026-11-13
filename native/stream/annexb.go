package main

import (
	"time"

	"github.com/pion/webrtc/v4/pkg/media"
)

// annexbParser turns a raw H.264 Annex-B byte stream (e.g. `ffmpeg -f h264 pipe:1`)
// into per-frame samples. Raw pipes carry no framing or timestamps, so the parser
// splits NAL units itself and synthesizes durations from the configured fps.
//
// Frame boundaries, in the order encoders emit NAL units:
//   - AUD (type 9) starts a frame.
//   - SPS (7) / PPS (8) / SEI (6) belong to the *next* frame: if the current
//     frame already has a slice, they start a new frame first.
//   - A VCL slice (types 1-5) starts a new frame once the current one already
//     has a slice (realtime encoders emit single-slice frames, so this is safe).
//
// Keyframe detection is unnecessary here: pion samples carry no keyframe flag and
// late joiners are covered by the encoder's GOP (see buildFfmpegArgs: 2s).
type annexbParser struct {
	buf     []byte // unconsumed input, starting at (or before) the next start code
	frame   []byte // Annex-B NALs of the frame being accumulated
	hasVCL  bool
	frameNs time.Duration
}

func newAnnexbParser(fps int) *annexbParser {
	return &annexbParser{frameNs: time.Second / time.Duration(fps)}
}

// feed consumes bytes and returns the samples that became complete.
// Incomplete trailing data stays buffered until the next feed.
func (p *annexbParser) feed(data []byte) []media.Sample {
	p.buf = append(p.buf, data...)
	var samples []media.Sample
	for {
		nalu, rest, ok := nextNAL(p.buf)
		if !ok {
			break // no complete NAL unit yet; keep buffering
		}
		p.buf = rest
		if len(nalu) > 0 {
			samples = append(samples, p.push(nalu)...)
		}
	}
	return samples
}

// push routes one complete NAL unit (no start code) into the frame accumulator.
func (p *annexbParser) push(nalu []byte) []media.Sample {
	switch nalu[0] & 0x1F {
	case 9: // AUD: explicit frame boundary
		out := p.flush()
		p.appendNAL(nalu)
		return out
	case 6, 7, 8: // SEI/SPS/PPS: parameter sets open the next frame
		out := []media.Sample{}
		if p.hasVCL {
			out = p.flush()
		}
		p.appendNAL(nalu)
		return out
	case 1, 2, 3, 4, 5: // VCL slices
		var out []media.Sample
		if p.hasVCL {
			out = p.flush()
		}
		p.appendNAL(nalu)
		p.hasVCL = true
		return out
	default: // filler and anything else: attach to the current frame
		p.appendNAL(nalu)
		return nil
	}
}

// final flushes the frame in progress when the byte stream ends. The last NAL
// unit has no following start code, so EOF itself is its delimiter: the
// pending buffer still holds start code + data and is parsed here first.
// Trailing parameter sets with no slice are discarded.
func (p *annexbParser) final() []media.Sample {
	pending := p.buf
	p.buf = nil
	var out []media.Sample
	if start, codeLen := findStartCode(pending); start >= 0 {
		if nalu := pending[start+codeLen:]; len(nalu) > 0 {
			out = append(out, p.push(nalu)...)
		}
	}
	return append(out, p.flush()...)
}

func (p *annexbParser) appendNAL(nalu []byte) {
	p.frame = append(p.frame, 0, 0, 0, 1)
	p.frame = append(p.frame, nalu...)
}

// flush emits the accumulated frame, if it has a VCL slice, and starts a new one.
// The emitted sample keeps the old backing array; a fresh buffer is allocated
// for the next frame so appends never mutate sent data.
func (p *annexbParser) flush() []media.Sample {
	if !p.hasVCL || len(p.frame) == 0 {
		p.frame = p.frame[:0]
		p.hasVCL = false
		return nil
	}
	sample := media.Sample{Data: p.frame, Duration: p.frameNs}
	p.frame = make([]byte, 0, len(sample.Data))
	p.hasVCL = false
	return []media.Sample{sample}
}

// nextNAL splits buf at its first start code. It returns the NAL unit bytes
// (after the start code, up to the next start code) and rest (starting at the
// next start code). ok=false means no complete NAL is available yet; the
// caller must keep buffering buf.
func nextNAL(buf []byte) (nalu []byte, rest []byte, ok bool) {
	start, codeLen := findStartCode(buf)
	if start < 0 {
		return nil, buf, false
	}
	next, _ := findStartCode(buf[start+codeLen:])
	if next < 0 {
		return nil, buf, false
	}
	// findStartCode returned an offset relative to the slice it searched.
	absNext := start + codeLen + next
	return buf[start+codeLen : absNext], buf[absNext:], true
}

// findStartCode locates the first Annex-B start code (00 00 01, optionally
// 00 00 00 01) in buf, returning its offset and length; -1 when none exists.
func findStartCode(buf []byte) (int, int) {
	for i := 0; i+2 < len(buf); i++ {
		if buf[i] == 0 && buf[i+1] == 0 && buf[i+2] == 1 {
			if i > 0 && buf[i-1] == 0 {
				return i - 1, 4
			}
			return i, 3
		}
	}
	return -1, 0
}

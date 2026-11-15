pub const ANNEXB_START_CODE: [u8; 4] = [0x00, 0x00, 0x00, 0x01];

/// Convert 4-byte big-endian length-prefixed AVCC H.264 access unit into Annex-B,
/// optionally prepending SPS/PPS on keyframes if not already present.
pub fn avcc_to_annexb(
    avcc: &[u8],
    sps_list: &[Vec<u8>],
    pps_list: &[Vec<u8>],
    force_sps_pps: bool,
) -> (Vec<u8>, bool) {
    let mut nalus: Vec<&[u8]> = Vec::new();
    let mut has_idr = false;
    let mut has_sps = false;
    let mut has_pps = false;

    let mut offset = 0usize;
    while offset + 4 <= avcc.len() {
        let len = u32::from_be_bytes([
            avcc[offset],
            avcc[offset + 1],
            avcc[offset + 2],
            avcc[offset + 3],
        ]) as usize;
        offset += 4;
        if len == 0 || offset + len > avcc.len() {
            break;
        }
        let nalu = &avcc[offset..offset + len];
        let nalu_type = nalu[0] & 0x1F;
        match nalu_type {
            5 => has_idr = true,
            7 => has_sps = true,
            8 => has_pps = true,
            _ => {}
        }
        nalus.push(nalu);
        offset += len;
    }

    let need_param_sets = (has_idr || force_sps_pps) && (!has_sps || !has_pps);
    let mut out = Vec::with_capacity(avcc.len() + 128);
    if need_param_sets {
        for sps in sps_list {
            if !sps.is_empty() {
                out.extend_from_slice(&ANNEXB_START_CODE);
                out.extend_from_slice(sps);
            }
        }
        for pps in pps_list {
            if !pps.is_empty() {
                out.extend_from_slice(&ANNEXB_START_CODE);
                out.extend_from_slice(pps);
            }
        }
    }

    for nalu in nalus {
        out.extend_from_slice(&ANNEXB_START_CODE);
        out.extend_from_slice(nalu);
    }

    (out, has_idr)
}

#[allow(dead_code)]
pub fn contains_idr_annexb(data: &[u8]) -> bool {
    let mut i = 0usize;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 {
            let start_len = if data[i + 2] == 1 {
                3
            } else if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                4
            } else {
                0
            };
            if start_len > 0 {
                let nalu_idx = i + start_len;
                if nalu_idx < data.len() && (data[nalu_idx] & 0x1F) == 5 {
                    return true;
                }
                i = nalu_idx;
                continue;
            }
        }
        i += 1;
    }
    false
}

/// Incremental Annex-B byte-stream parser that splits raw ffmpeg H.264 output
/// into complete access units `(annexb_bytes, is_keyframe)` on VCL->non-VCL or AUD boundaries.
pub struct AnnexBStreamSplitter {
    buf: Vec<u8>,
    last_sps: Vec<u8>,
    last_pps: Vec<u8>,
}

impl AnnexBStreamSplitter {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
            last_sps: Vec::new(),
            last_pps: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<(Vec<u8>, bool)> {
        self.buf.extend_from_slice(chunk);
        self.drain_frames(false)
    }

    pub fn finish(&mut self) -> Vec<(Vec<u8>, bool)> {
        self.drain_frames(true)
    }

    fn find_start_code(data: &[u8], from: usize) -> Option<(usize, usize)> {
        let mut i = from;
        while i + 3 <= data.len() {
            if data[i] == 0 && data[i + 1] == 0 {
                if data[i + 2] == 1 {
                    return Some((i, 3));
                }
                if i + 3 < data.len() && data[i + 2] == 0 && data[i + 3] == 1 {
                    return Some((i, 4));
                }
            }
            i += 1;
        }
        None
    }

    fn drain_frames(&mut self, eof: bool) -> Vec<(Vec<u8>, bool)> {
        let mut out = Vec::new();
        let mut starts: Vec<(usize, usize)> = Vec::new();
        let mut pos = 0usize;
        while let Some((idx, sc_len)) = Self::find_start_code(&self.buf, pos) {
            starts.push((idx, sc_len));
            pos = idx + sc_len;
        }
        if starts.is_empty() {
            if eof {
                self.buf.clear();
            }
            return out;
        }

        let mut frame_start = starts[0].0;
        let mut seen_vcl = false;
        let mut consumed_until = 0usize;

        for (w, &(idx, sc_len)) in starts.iter().enumerate() {
            let is_complete = w + 1 < starts.len() || eof;
            let nalu_end = if w + 1 < starts.len() {
                starts[w + 1].0
            } else {
                self.buf.len()
            };
            let header_pos = idx + sc_len;
            if header_pos >= nalu_end {
                continue;
            }
            let nalu_type = self.buf[header_pos] & 0x1F;
            let is_vcl = matches!(nalu_type, 1..=5);
            let starts_new_au = seen_vcl && (matches!(nalu_type, 9 | 7 | 8 | 6) || is_vcl);

            if starts_new_au && idx > frame_start {
                if let Some(frame) = self.build_frame(&self.buf[frame_start..idx]) {
                    out.push(frame);
                }
                consumed_until = idx;
                frame_start = idx;
                seen_vcl = false;
            }

            if is_complete {
                let nalu = &self.buf[header_pos..nalu_end];
                if nalu_type == 7 {
                    self.last_sps = nalu.to_vec();
                } else if nalu_type == 8 {
                    self.last_pps = nalu.to_vec();
                }
                if is_vcl {
                    seen_vcl = true;
                }
            }
        }

        if eof {
            if frame_start < self.buf.len() {
                if let Some(frame) = self.build_frame(&self.buf[frame_start..]) {
                    out.push(frame);
                }
            }
            self.buf.clear();
        } else if consumed_until > 0 {
            self.buf.drain(..consumed_until);
        }
        out
    }

    fn build_frame(&self, raw: &[u8]) -> Option<(Vec<u8>, bool)> {
        let mut has_vcl = false;
        let mut has_idr = false;
        let mut has_sps = false;
        let mut has_pps = false;
        let mut pos = 0usize;
        while let Some((idx, sc_len)) = Self::find_start_code(raw, pos) {
            let nalu_start = idx + sc_len;
            let next = Self::find_start_code(raw, nalu_start)
                .map(|(n, _)| n)
                .unwrap_or(raw.len());
            if nalu_start < next {
                match raw[nalu_start] & 0x1F {
                    5 => {
                        has_idr = true;
                        has_vcl = true;
                    }
                    1..=4 => {
                        has_vcl = true;
                    }
                    7 => has_sps = true,
                    8 => has_pps = true,
                    _ => {}
                }
            }
            pos = next;
        }
        if !has_vcl {
            return None;
        }
        let mut out = Vec::with_capacity(raw.len() + 64);
        if has_idr && (!has_sps || !has_pps) {
            if !self.last_sps.is_empty() && !has_sps {
                out.extend_from_slice(&ANNEXB_START_CODE);
                out.extend_from_slice(&self.last_sps);
            }
            if !self.last_pps.is_empty() && !has_pps {
                out.extend_from_slice(&ANNEXB_START_CODE);
                out.extend_from_slice(&self.last_pps);
            }
        }
        out.extend_from_slice(raw);
        Some((out, has_idr))
    }
}

/// Convert raw BGRA8 (4 bytes per pixel) to RGB8 buffer for jpeg-encoder.
#[allow(dead_code)]
pub fn bgra_to_rgb(bgra: &[u8], width: usize, height: usize, bytes_per_row: usize) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(width * height * 3);
    for y in 0..height {
        let row_start = y * bytes_per_row;
        let row_end = (row_start + width * 4).min(bgra.len());
        if row_start >= bgra.len() {
            break;
        }
        let row = &bgra[row_start..row_end];
        for px in row.chunks_exact(4) {
            rgb.push(px[2]); // R
            rgb.push(px[1]); // G
            rgb.push(px[0]); // B
        }
    }
    rgb
}

/// Bilinearly / box-nearest downscale BGRA buffer when max_dim is smaller than src.
#[allow(dead_code)]
pub fn downscale_bgra(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    src_stride: usize,
    dst_w: usize,
    dst_h: usize,
) -> Vec<u8> {
    if dst_w == src_w && dst_h == src_h && src_stride == src_w * 4 {
        return src[..src_w * src_h * 4].to_vec();
    }
    let mut dst = vec![0u8; dst_w * dst_h * 4];
    for y in 0..dst_h {
        let sy = (y * src_h) / dst_h.max(1);
        let srow = sy.min(src_h.saturating_sub(1)) * src_stride;
        let drow = y * dst_w * 4;
        for x in 0..dst_w {
            let sx = (x * src_w) / dst_w.max(1);
            let si = srow + sx.min(src_w.saturating_sub(1)) * 4;
            let di = drow + x * 4;
            if si + 4 <= src.len() && di + 4 <= dst.len() {
                dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
            }
        }
    }
    dst
}

pub fn fit_within_max_dim(width: u32, height: u32, max_dim: u32) -> (u32, u32) {
    if max_dim == 0 || (width <= max_dim && height <= max_dim) {
        return (make_even(width), make_even(height));
    }
    let w = width as f64;
    let h = height as f64;
    let scale = (max_dim as f64) / w.max(h).max(1.0);
    let nw = ((w * scale).round() as u32).max(2);
    let nh = ((h * scale).round() as u32).max(2);
    (make_even(nw), make_even(nh))
}

#[inline]
pub fn make_even(v: u32) -> u32 {
    if v <= 2 {
        2
    } else {
        v & !1
    }
}

#[allow(dead_code)]
pub fn encode_jpeg_from_bgra(
    bgra: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    quality: u8,
) -> anyhow::Result<Vec<u8>> {
    let rgb = bgra_to_rgb(bgra, width as usize, height as usize, stride);
    let mut out = Vec::with_capacity((width * height / 4) as usize);
    let encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(20, 95));
    encoder.encode(&rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_avcc_to_annexb_prepends_sps_pps_on_idr() {
        let sps = vec![0x67, 0x42, 0xE0, 0x1F];
        let pps = vec![0x68, 0xCE, 0x3C, 0x80];
        let idr = vec![0x65, 0x88, 0x84, 0x21];
        let mut avcc = Vec::new();
        avcc.extend_from_slice(&(idr.len() as u32).to_be_bytes());
        avcc.extend_from_slice(&idr);

        let (annexb, is_key) = avcc_to_annexb(&avcc, &[sps.clone()], &[pps.clone()], false);
        assert!(is_key);
        assert!(contains_idr_annexb(&annexb));
        assert!(annexb.starts_with(&[0, 0, 0, 1, 0x67]));
        assert!(annexb.windows(5).any(|w| w == [0, 0, 0, 1, 0x68]));
        assert!(annexb.windows(5).any(|w| w == [0, 0, 0, 1, 0x65]));
    }

    #[test]
    fn test_fit_within_max_dim_even() {
        assert_eq!(fit_within_max_dim(2560, 1600, 1440), (1440, 900));
        assert_eq!(fit_within_max_dim(1281, 721, 0), (1280, 720));
    }

    #[test]
    fn annexb_splitter_separates_access_units() {
        let mut s = AnnexBStreamSplitter::new();
        let stream = [
            0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, // SPS
            0, 0, 0, 1, 0x68, 0xce, 0x38, 0x80, // PPS
            0, 0, 0, 1, 0x65, 0x88, 0x84,       // IDR
            0, 0, 0, 1, 0x41, 0x9a, 0x22,       // P-frame
        ];
        let mut frames = s.push(&stream);
        frames.extend(s.finish());
        assert_eq!(frames.len(), 2);
        assert!(frames[0].1);
        assert!(!frames[1].1);
    }
}

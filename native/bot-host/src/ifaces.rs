use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::Duration;

const VIRTUAL_IFACE_PREFIXES: &[&str] = &[
    "awdl",
    "llw",
    "anpi",
    "bridge",
    "vmenet",
    "ap",
    "gif",
    "stf",
    "utun",
    "tailscale",
    "wg",
    "docker",
    "veth",
];

pub fn is_virtual_interface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_IFACE_PREFIXES
        .iter()
        .any(|prefix| lower.starts_with(prefix))
}

pub fn is_ignored_ip(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    match ip {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            // 198.18.0.0/15 (RFC 2544 benchmarking / Clash fake-IP)
            if octets[0] == 198 && (octets[1] == 18 || octets[1] == 19) {
                return true;
            }
            // 169.254.0.0/16 (link-local)
            if octets[0] == 169 && octets[1] == 254 {
                return true;
            }
            false
        }
        IpAddr::V6(v6) => {
            let segs = v6.segments();
            // fe80::/10 link-local
            if (segs[0] & 0xffc0) == 0xfe80 {
                return true;
            }
            // fdfe:dcba:9876::/48 fake IPv6
            if segs[0] == 0xfdfe && segs[1] == 0xdcba && segs[2] == 0x9876 {
                return true;
            }
            false
        }
    }
}

pub fn local_host_ips() -> Vec<IpAddr> {
    let mut out = Vec::new();
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return out;
    };
    for iface in ifaces {
        if iface.is_loopback() || is_virtual_interface(&iface.name) {
            continue;
        }
        let ip = iface.ip();
        if is_ignored_ip(ip) {
            continue;
        }
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    // Prefer IPv4 first, private LAN before public
    out.sort_by_key(|ip| match ip {
        IpAddr::V4(v4) => {
            if v4.is_private() {
                0
            } else {
                1
            }
        }
        IpAddr::V6(_) => 2,
    });
    out
}

pub async fn gather_srflx_addr_async(
    socket: &tokio::net::UdpSocket,
    stun_url: &str,
    timeout: Duration,
) -> Option<SocketAddr> {
    let host_port = stun_url
        .strip_prefix("stun:")
        .or_else(|| stun_url.strip_prefix("stuns:"))?
        .split('?')
        .next()?
        .trim();
    let dest = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:3478")
    };
    let is_v4 = socket.local_addr().map(|l| l.is_ipv4()).unwrap_or(true);
    let server_addr = tokio::net::lookup_host(&dest)
        .await
        .ok()?
        .find(|addr| addr.is_ipv4() == is_v4)?;

    let mut tx_id = [0u8; 12];
    for (idx, b) in tx_id.iter_mut().enumerate() {
        *b = rand::random::<u8>().wrapping_add(idx as u8);
    }
    let mut req = [0u8; 20];
    req[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    req[2..4].copy_from_slice(&0u16.to_be_bytes());
    req[4..8].copy_from_slice(&0x2112_A442u32.to_be_bytes());
    req[8..20].copy_from_slice(&tx_id);

    socket.send_to(&req, server_addr).await.ok()?;
    let mut buf = [0u8; 512];
    let recv_res = tokio::time::timeout(timeout, socket.recv_from(&mut buf)).await.ok()?.ok()?;
    parse_stun_binding_response(&buf[..recv_res.0], &tx_id)
}

/// Minimal RFC 5389 STUN Binding Request over an already-bound UDP socket
/// to discover our server-reflexive IP:port when STUN servers are configured.
#[allow(dead_code)]
pub fn gather_srflx_addr(socket: &UdpSocket, stun_url: &str, timeout: Duration) -> Option<SocketAddr> {
    let host_port = stun_url
        .strip_prefix("stun:")
        .or_else(|| stun_url.strip_prefix("stuns:"))?
        .split('?')
        .next()?
        .trim();
    let dest = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:3478")
    };
    let server_addr = dest
        .to_socket_addrs()
        .ok()?
        .find(|addr| addr.is_ipv4() == socket.local_addr().map(|l| l.is_ipv4()).unwrap_or(true))?;

    let mut tx_id = [0u8; 12];
    for (idx, b) in tx_id.iter_mut().enumerate() {
        *b = rand::random::<u8>().wrapping_add(idx as u8);
    }

    // STUN Binding Request: type 0x0001, length 0, magic cookie 0x2112A442, 12B tx_id
    let mut req = [0u8; 20];
    req[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    req[2..4].copy_from_slice(&0u16.to_be_bytes());
    req[4..8].copy_from_slice(&0x2112_A442u32.to_be_bytes());
    req[8..20].copy_from_slice(&tx_id);

    socket.send_to(&req, server_addr).ok()?;
    let prev_timeout = socket.read_timeout().ok().flatten();
    let _ = socket.set_read_timeout(Some(timeout));

    let mut buf = [0u8; 512];
    let result = match socket.recv_from(&mut buf) {
        Ok((n, _)) => parse_stun_binding_response(&buf[..n], &tx_id),
        Err(_) => None,
    };
    let _ = socket.set_read_timeout(prev_timeout);
    result
}

fn parse_stun_binding_response(pkt: &[u8], expected_tx: &[u8; 12]) -> Option<SocketAddr> {
    if pkt.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([pkt[0], pkt[1]]);
    let msg_len = u16::from_be_bytes([pkt[2], pkt[3]]) as usize;
    let cookie = u32::from_be_bytes([pkt[4], pkt[5], pkt[6], pkt[7]]);
    if msg_type != 0x0101 || cookie != 0x2112_A442 || &pkt[8..20] != expected_tx {
        return None;
    }
    let end = (20 + msg_len).min(pkt.len());
    let mut pos = 20usize;
    let mut mapped: Option<SocketAddr> = None;

    while pos + 4 <= end {
        let attr_type = u16::from_be_bytes([pkt[pos], pkt[pos + 1]]);
        let attr_len = u16::from_be_bytes([pkt[pos + 2], pkt[pos + 3]]) as usize;
        pos += 4;
        if pos + attr_len > end {
            break;
        }
        let val = &pkt[pos..pos + attr_len];
        // XOR-MAPPED-ADDRESS (0x0020) preferred, fallback MAPPED-ADDRESS (0x0001)
        if attr_type == 0x0020 && val.len() >= 8 {
            let family = val[1];
            let xport = u16::from_be_bytes([val[2], val[3]]) ^ 0x2112;
            if family == 0x01 && val.len() >= 8 {
                let raw = u32::from_be_bytes([val[4], val[5], val[6], val[7]]) ^ 0x2112_A442;
                return Some(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(raw)), xport));
            } else if family == 0x02 && val.len() >= 20 {
                let mut xor_key = [0u8; 16];
                xor_key[0..4].copy_from_slice(&0x2112_A442u32.to_be_bytes());
                xor_key[4..16].copy_from_slice(expected_tx);
                let mut ip_bytes = [0u8; 16];
                for i in 0..16 {
                    ip_bytes[i] = val[4 + i] ^ xor_key[i];
                }
                return Some(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(ip_bytes)), xport));
            }
        } else if attr_type == 0x0001 && val.len() >= 8 {
            let family = val[1];
            let port = u16::from_be_bytes([val[2], val[3]]);
            if family == 0x01 {
                let ip = Ipv4Addr::new(val[4], val[5], val[6], val[7]);
                mapped = Some(SocketAddr::new(IpAddr::V4(ip), port));
            }
        }
        pos += (attr_len + 3) & !3;
    }
    mapped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_filters_virtual_and_fake_ips() {
        assert!(is_virtual_interface("awdl0"));
        assert!(is_virtual_interface("utun4"));
        assert!(!is_virtual_interface("en0"));
        assert!(is_ignored_ip("198.18.0.1".parse().unwrap()));
        assert!(is_ignored_ip("198.19.255.254".parse().unwrap()));
        assert!(is_ignored_ip("fdfe:dcba:9876::1".parse().unwrap()));
        assert!(is_ignored_ip("169.254.1.2".parse().unwrap()));
        assert!(is_ignored_ip("fe80::1".parse().unwrap()));
        assert!(!is_ignored_ip("192.168.1.50".parse().unwrap()));
    }
}

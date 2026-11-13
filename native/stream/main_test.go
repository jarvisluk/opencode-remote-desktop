package main

import (
	"net"
	"testing"
)

func TestIsAllowedInterface(t *testing.T) {
	allowed := []string{"en0", "en1", "utun4", "eth0", "wlan0", "tailscale0"}
	for _, name := range allowed {
		if !isAllowedInterface(name) {
			t.Errorf("expected interface %q to be allowed", name)
		}
	}
	blocked := []string{"awdl0", "llw0", "anpi0", "anpi1", "bridge0", "ap1", "gif0", "stf0"}
	for _, name := range blocked {
		if isAllowedInterface(name) {
			t.Errorf("expected interface %q to be filtered out", name)
		}
	}
}

func TestIsAllowedIP(t *testing.T) {
	allowed := []string{"192.168.31.86", "100.108.57.99", "10.0.0.5", "172.20.10.2"}
	for _, s := range allowed {
		if !isAllowedIP(net.ParseIP(s)) {
			t.Errorf("expected IP %s to be allowed", s)
		}
	}
	blocked := []string{"198.18.0.1", "198.19.255.254", "169.254.10.1", "fe80::1", "0.0.0.0", "224.0.0.251"}
	for _, s := range blocked {
		if isAllowedIP(net.ParseIP(s)) {
			t.Errorf("expected IP %s to be filtered out", s)
		}
	}
}

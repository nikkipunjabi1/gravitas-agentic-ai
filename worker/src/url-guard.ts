import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * URL sanitisation for visitor-submitted URLs.
 *
 * docs/ARCHITECTURE.md → Security: we reject
 *   - Non-http(s) schemes (no `file://`, `javascript:`, etc.)
 *   - RFC1918 / loopback / link-local IPs (no SSRF)
 *   - URLs > 2KB
 *
 * This guard runs in the worker so an SSRF attempt cannot pivot off the
 * Next.js app's network position. The check is BOTH on the parsed hostname
 * (to catch literal IPs) AND on the DNS-resolved IPs (to catch DNS rebinding
 * tricks). For Phase 0 we resolve once at validation time; Phase 1 should
 * also pin the resolved IP through to Playwright's connection to avoid the
 * time-of-check / time-of-use gap.
 */

export type UrlGuardOk = { ok: true; url: URL };
export type UrlGuardErr = { ok: false; reason: string };
export type UrlGuardResult = UrlGuardOk | UrlGuardErr;

const MAX_LENGTH = 2048;

export async function sanitiseUrl(raw: string): Promise<UrlGuardResult> {
  if (raw.length > MAX_LENGTH) {
    return { ok: false, reason: "url_too_long" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url_parse_failed" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  if (!url.hostname) {
    return { ok: false, reason: "missing_hostname" };
  }

  // If the hostname is a literal IP, check it directly.
  const literalIpVersion = isIP(url.hostname);
  if (literalIpVersion !== 0) {
    if (isPrivateAddress(url.hostname)) {
      return { ok: false, reason: "private_address_blocked" };
    }
    return { ok: true, url };
  }

  // Hostname is a name — resolve and check every resulting IP.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(url.hostname, { all: true });
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: "dns_resolution_empty" };
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      return { ok: false, reason: "private_address_blocked" };
    }
  }

  return { ok: true, url };
}

/**
 * Recognises RFC1918, loopback, link-local, multicast, and the common ranges
 * one shouldn't crawl from a server. NOT exhaustive — pair with a corporate
 * egress firewall in production.
 */
export function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 4) {
    const parts = addr.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1") return true;
    if (lower === "::") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("ff")) return true; // multicast
    // IPv4-mapped IPv6 (::ffff:0:0/96) — defer to v4 logic on the suffix.
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice("::ffff:".length);
      if (isIP(v4) === 4) return isPrivateAddress(v4);
    }
    return false;
  }
  // Not an IP → caller should have resolved DNS first.
  return true;
}

import { isIP } from 'node:net';

/** True for loopback, private, link-local, CGNAT, unspecified, multicast and unique-local addresses (v4, v6 and v4-mapped v6). */
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  const kind = isIP(a);
  if (kind === 0) return true; // not an IP literal: refuse rather than guess
  if (kind === 6) {
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped !== null) return isPrivateAddress(mapped[1] as string);
    const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex !== null) {
      const hi = parseInt(hex[1] as string, 16);
      const lo = parseInt(hex[2] as string, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // NAT64 (64:ff9b::/96), 6to4 (2002::/16), Teredo (2001::/32) and the documentation range can embed or alias private IPv4 space: refuse them outright
    if (/^(64:ff9b:|2002:|2001:0{0,3}:|2001:db8)/.test(a)) return true;
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') || /^fe[89ab]/.test(a) || a.startsWith('ff');
  }
  const p = a.split('.').map(Number) as [number, number, number, number];
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0)
  );
}

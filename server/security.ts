// Auth (operator token -> HS256 JWT), rate limiting and IP allowlist. node:crypto only.
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { BlockList, isIPv6 } from 'node:net';

// ---------- operator token (scrypt) ----------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashOperatorToken(token: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(token, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyOperatorToken(token: string, stored: string): boolean {
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = scryptSync(token, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------- JWT (HS256) ----------
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export interface Claims { sub: string; role: 'operator'; iat: number; exp: number; jti: string }

export function signJwt(secret: Buffer, sub: string, ttlSec: number): { token: string; claims: Claims } {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = { sub, role: 'operator', iat: now, exp: now + ttlSec, jti: randomUUID() };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return { token: `${head}.${body}.${sig}`, claims };
}

export function verifyJwt(secret: Buffer, token: string, revoked: (jti: string) => boolean): Claims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const h = JSON.parse(Buffer.from(head, 'base64url').toString());
    if (h.alg !== 'HS256') return null; // never accept "none" or asymmetric algs
    const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
    if (typeof c.exp !== 'number' || c.exp <= Math.floor(Date.now() / 1000)) return null;
    if (c.role !== 'operator' || revoked(c.jti)) return null;
    return c;
  } catch { return null; }
}

// ---------- rate limiting (token bucket per key) ----------
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSec: number) {
    setInterval(() => { const cut = Date.now() - 10 * 60_000; for (const [k, b] of this.buckets) if (b.at < cut) this.buckets.delete(k); }, 60_000).unref();
  }
  /** Returns seconds to wait, or 0 if allowed. */
  take(key: string, cost = 1): number {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.refillPerSec);
    b.at = now;
    if (b.tokens < cost) { this.buckets.set(key, b); return Math.ceil((cost - b.tokens) / this.refillPerSec); }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return 0;
  }
}

// ---------- IP allowlist ----------
export function makeAllowlist(cidrs: string[]) {
  if (cidrs.length === 0) return () => true;
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const type = isIPv6(addr) ? 'ipv6' : 'ipv4';
    if (bits) list.addSubnet(addr, Number(bits), type); else list.addAddress(addr, type);
  }
  return (ip: string) => {
    const clean = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
    return list.check(clean, isIPv6(clean) ? 'ipv6' : 'ipv4');
  };
}

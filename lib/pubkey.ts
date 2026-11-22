// Public-key helpers only. The terminal never handles private keys or seed phrases.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodeBase58(s: string): Uint8Array | null {
  if (!s || s.length > 64) return null;
  let n = BigInt(0);
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * BigInt(58) + BigInt(i);
  }
  const out: number[] = [];
  while (n > BigInt(0)) {
    out.unshift(Number(n & BigInt(255)));
    n >>= BigInt(8);
  }
  for (const c of s) {
    if (c === '1') out.unshift(0);
    else break;
  }
  return Uint8Array.from(out);
}

export function encodeBase58(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) + BigInt(b);
  let out = '';
  while (n > BigInt(0)) {
    out = ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

export const isPubkey = (s: string) => decodeBase58(s.trim())?.length === 32;

export function randomPubkey(rand: () => number = Math.random) {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(rand() * 256);
  b[0] ||= 1;
  return encodeBase58(b);
}

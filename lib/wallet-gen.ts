// Client-side Ed25519 Solana keypair generator using Web Crypto API.
// Private keys are generated locally in the browser and NEVER sent to any server or stored in localStorage.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

export interface GeneratedSolanaWallet {
  publicKey: string;
  secretKeyBase58: string;
  keypairJson: string;
}

/**
 * Generates a fresh cryptographically secure Solana Ed25519 keypair in-browser.
 * Returns the base58 public address, base58 64-byte secret key (for Phantom/Solflare import),
 * and Solana CLI JSON array format (for `whal-engine secrets import-keypair`).
 */
export async function generateSolanaKeypair(): Promise<GeneratedSolanaWallet> {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    throw new Error('Web Crypto API is unavailable in this browser context (requires localhost or HTTPS).');
  }

  const pair = (await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey));

  if (rawPub.length !== 32 || pkcs8.length < 32) {
    throw new Error('Unexpected Ed25519 key export length.');
  }

  // RFC 8410 Ed25519 PKCS#8 ends with the 32-byte private seed.
  const seed32 = pkcs8.slice(pkcs8.length - 32);
  const secret64 = new Uint8Array(64);
  secret64.set(seed32, 0);
  secret64.set(rawPub, 32);

  return {
    publicKey: encodeBase58(rawPub),
    secretKeyBase58: encodeBase58(secret64),
    keypairJson: JSON.stringify(Array.from(secret64)),
  };
}

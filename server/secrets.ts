// Encrypted-at-rest secret store. Same file format as engine/whal-config/src/secrets.rs:
//   { "<id>": { "nonce": b64(12 bytes), "ciphertext": b64(ct || 16-byte tag), "updated_at": unix_secs } }
// Cipher: ChaCha20-Poly1305 (IETF), random 96-bit nonce per write, secret id as AAD.
// Only status() is reachable from HTTP handlers; reveal() exists for engine-side use.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SECRETS, type SecretStatus } from '../lib/config/schema';

interface Sealed { nonce: string; ciphertext: string; updated_at: number }
const TAG = 16;

export class SecretStore {
  private entries: Record<string, Sealed> = {};
  constructor(private file: string, private key: Buffer) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) this.entries = JSON.parse(readFileSync(file, 'utf8'));
    for (const id of Object.keys(this.entries)) this.reveal(id); // fail fast on a wrong key
  }

  status(): Record<string, SecretStatus> {
    return Object.fromEntries(SECRETS.map((s) => {
      const e = this.entries[s.id];
      return [s.id, e ? { set: true, updatedAt: e.updated_at * 1000 } : { set: false, updatedAt: null }];
    }));
  }

  /** From the operator API. The signer key is host-only and refused here. */
  setFromApi(id: string, value: string) {
    const meta = SECRETS.find((s) => s.id === id);
    if (!meta) throw Object.assign(new Error('Unknown secret'), { status: 404 });
    if (!meta.uiSettable) throw Object.assign(new Error('This secret can only be set on the engine host'), { status: 403 });
    if (!value || value.length > 16_384) throw Object.assign(new Error('Value is empty or too long'), { status: 400 });
    const nonce = randomBytes(12);
    const c = createCipheriv('chacha20-poly1305', this.key, nonce, { authTagLength: TAG });
    c.setAAD(Buffer.from(id), { plaintextLength: Buffer.byteLength(value) });
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final(), c.getAuthTag()]);
    this.entries[id] = { nonce: nonce.toString('base64'), ciphertext: ct.toString('base64'), updated_at: Math.floor(Date.now() / 1000) };
    this.persist();
  }

  clearFromApi(id: string) {
    const meta = SECRETS.find((s) => s.id === id);
    if (!meta) throw Object.assign(new Error('Unknown secret'), { status: 404 });
    if (!meta.uiSettable) throw Object.assign(new Error('This secret can only be changed on the engine host'), { status: 403 });
    delete this.entries[id];
    this.persist();
  }

  /** Engine-side only. Never call from a request handler. */
  reveal(id: string): Buffer {
    const e = this.entries[id];
    if (!e) throw new Error(`secret ${id} not set`);
    const raw = Buffer.from(e.ciphertext, 'base64');
    const d = createDecipheriv('chacha20-poly1305', this.key, Buffer.from(e.nonce, 'base64'), { authTagLength: TAG });
    d.setAAD(Buffer.from(id), { plaintextLength: raw.length - TAG });
    d.setAuthTag(raw.subarray(raw.length - TAG));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - TAG)), d.final()]);
  }

  private persist() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

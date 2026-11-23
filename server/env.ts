// Control-plane settings from environment variables. Fails fast on unsafe values.
import { isIP } from 'node:net';
import path from 'node:path';

export interface Env {
  host: string;
  port: number;
  dbPath: string;
  secretsPath: string;
  jwtSecret: Buffer;
  jwtTtlSec: number;
  operatorTokenHash: string;
  masterKey: Buffer;
  corsOrigins: string[];
  ipAllowlist: string[]; // CIDRs; empty = allow all
  trustProxy: boolean;
  engineMode: 'simulated' | 'bridge';
  engineBridgeToken: string | null;
  devApiKey: string | null;
}

function req(name: string, e: NodeJS.ProcessEnv) {
  const v = e[name]?.trim();
  if (!v) throw new Error(`${name} is required (see server/README.md)`);
  return v;
}

export function loadEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const jwtSecret = Buffer.from(req('WHAL_JWT_SECRET', e), 'base64');
  if (jwtSecret.length < 32) throw new Error('WHAL_JWT_SECRET must be at least 32 bytes, base64-encoded');
  const masterKey = Buffer.from(req('WHAL_MASTER_KEY', e), 'base64');
  if (masterKey.length !== 32) throw new Error('WHAL_MASTER_KEY must be exactly 32 bytes, base64-encoded');
  const operatorTokenHash = req('WHAL_OPERATOR_TOKEN_HASH', e);
  if (!/^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(operatorTokenHash)) throw new Error('WHAL_OPERATOR_TOKEN_HASH must come from `npm run server:hash-token`');

  const host = e.WHAL_HOST?.trim() || (e.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
  const ipAllowlist = (e.WHAL_IP_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const c of ipAllowlist) if (!isIP(c.split('/')[0])) throw new Error(`WHAL_IP_ALLOWLIST: bad entry ${c}`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && ipAllowlist.length === 0) {
    console.warn('[env] WARNING: listening on a non-loopback address without WHAL_IP_ALLOWLIST');
  }
  const engineMode = (e.WHAL_ENGINE_MODE ?? 'bridge') as Env['engineMode'];
  if (!['simulated', 'bridge'].includes(engineMode)) throw new Error('WHAL_ENGINE_MODE must be simulated or bridge');
  const engineBridgeToken = e.WHAL_ENGINE_BRIDGE_TOKEN?.trim() || null;
  if (engineMode === 'bridge' && (!engineBridgeToken || engineBridgeToken.length < 32)) throw new Error('WHAL_ENGINE_BRIDGE_TOKEN (≥32 chars) is required in bridge mode');

  const rawDevKey = e.WHAL_DEV_API_KEY?.trim() || null;
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (rawDevKey && !isLoopback) {
    throw new Error('WHAL_DEV_API_KEY is only permitted on loopback (127.0.0.1 / localhost)');
  }
  if (rawDevKey) {
    console.warn('[env] DEV API KEY enabled for local development (loopback only)');
  }

  // Automatically persist SQLite & secrets on Railway Volume if one is attached (any mount path).
  const dataDir = path.resolve(e.WHAL_DATA_DIR?.trim() || e.RAILWAY_VOLUME_MOUNT_PATH?.trim() || '.data');
  return {
    host,
    port: Number(e.PORT ?? e.WHAL_PORT ?? 8787),
    dbPath: e.WHAL_DB_PATH ?? path.join(dataDir, 'control-plane.sqlite'),
    secretsPath: e.WHAL_SECRETS_PATH ?? path.join(dataDir, 'secrets.enc'),
    jwtSecret,
    jwtTtlSec: Number(e.WHAL_JWT_TTL_SEC ?? 12 * 3600),
    operatorTokenHash,
    masterKey,
    corsOrigins: (e.WHAL_CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    ipAllowlist,
    trustProxy: e.WHAL_TRUST_PROXY === '1',
    engineMode,
    engineBridgeToken,
    devApiKey: rawDevKey,
  };
}

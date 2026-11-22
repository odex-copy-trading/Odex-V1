// Integration tests for the control plane (simulated engine). Run: npm run test:server
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { createApp } from '../app';
import { ControlPlane } from '../control';
import { Db } from '../db';
import { loadEnv, type Env } from '../env';
import { SecretStore } from '../secrets';
import { hashOperatorToken } from '../security';
import { SimulatedEngine } from '../engine/simulated';
import { randomPubkey } from '../../lib/pubkey';

const OP_TOKEN = 'op-token-for-tests-0123456789';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'whal-cp-'));
  const env = loadEnv({
    NODE_ENV: 'test', WHAL_ENGINE_MODE: 'simulated', WHAL_JWT_SECRET: randomBytes(48).toString('base64'), WHAL_MASTER_KEY: randomBytes(32).toString('base64'),
    WHAL_OPERATOR_TOKEN_HASH: hashOperatorToken(OP_TOKEN), WHAL_DATA_DIR: dir, WHAL_CORS_ORIGINS: 'http://localhost:3000', ...extra,
  });
  const db = new Db(env.dbPath);
  const secrets = new SecretStore(env.secretsPath, env.masterKey);
  const sim = new SimulatedEngine();
  const cp = new ControlPlane(db, secrets, sim, sim.seed());
  sim.start();
  await cp.syncEngine();
  const app = createApp(env, db, cp, null);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const stop = () => { app.close(); sim.stop(); db.close(); };
  return { env, db, cp, base, dir, stop };
}

type Boot = Awaited<ReturnType<typeof boot>>;
let s: Boot;
let jwt = '';
const call = async (method: string, p: string, body?: unknown, token = jwt) => {
  const r = await fetch(s.base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
};

describe('control plane', () => {
  before(async () => { s = await boot(); });
  after(() => s.stop());

  test('auth: rejects bad token, issues JWT, protects routes', async () => {
    assert.equal((await call('POST', '/api/auth/login', { token: 'wrong-token-wrong-token' }, '')).status, 401);
    const ok = await call('POST', '/api/auth/login', { token: OP_TOKEN }, '');
    assert.equal(ok.status, 200);
    jwt = ok.body.token;
    assert.equal((await call('GET', '/api/kols', undefined, '')).status, 401);
    assert.equal((await call('GET', '/api/kols', undefined, jwt.slice(0, -2) + 'xx')).status, 401);
    assert.equal((await call('GET', '/api/kols')).status, 200);
  });

  test('config: validation, conflict, hot vs restart, audit', async () => {
    const cur = (await call('GET', '/api/config')).body;
    const bad = structuredClone(cur.config); bad.strategy.min_buy_sol = 50; bad.strategy.max_buy_sol = 1;
    const r1 = await call('PUT', '/api/config', { baseVersion: cur.version, config: bad });
    assert.equal(r1.status, 400);
    assert.ok(r1.body.fields['strategy.max_buy_sol']);
    const next = structuredClone(cur.config); next.strategy.slippage_bps = 999; next.network.commitment = 'confirmed';
    assert.equal((await call('PUT', '/api/config', { baseVersion: cur.version - 1 || 99, config: next })).status, 409);
    const r2 = await call('PUT', '/api/config', { baseVersion: cur.version, config: next });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.appliedLive, ['strategy.slippage_bps']);
    assert.ok(r2.body.pendingRestart.includes('network.commitment'));
    const audit = (await call('GET', '/api/audit?limit=5')).body.items;
    assert.ok(audit.some((a: { action: string }) => a.action === 'config.update'));
  });

  test('secrets: write-only, encrypted at rest, signer key refused', async () => {
    const secret = 'grpc-token-SHOULD-NOT-LEAK';
    const r = await call('PUT', '/api/secrets/network.geyser_token', { value: secret });
    assert.equal(r.status, 200);
    assert.equal(r.body.set, true);
    assert.equal((await call('PUT', '/api/secrets/wallets.hot_wallet_keypair', { value: 'x' })).status, 403);
    for (const p of ['/api/config', '/api/state', '/api/audit']) assert.ok(!JSON.stringify((await call('GET', p)).body).includes(secret), p);
    for (const f of readdirSync(s.dir)) assert.ok(!readFileSync(path.join(s.dir, f)).includes(secret), f);
  });

  test('kols: CRUD with validation and duplicates', async () => {
    assert.equal((await call('POST', '/api/kols', { label: '', pubkey: 'nope' })).status, 400);
    const kol = { label: 'Test whale', pubkey: randomPubkey(), quote: 'SOL', triggerMargin: 0.02, buySizeSol: 1.5, maxCurveReserveSol: 50, enabled: true };
    const c = await call('POST', '/api/kols', kol);
    assert.equal(c.status, 201);
    assert.equal((await call('POST', '/api/kols', kol)).status, 409);
    const p = await call('PATCH', `/api/kols/${c.body.id}`, { buySizeSol: 2, enabled: false });
    assert.equal(p.body.buySizeSol, 2);
    assert.equal(p.body.enabled, false);
    assert.equal((await call('PATCH', `/api/kols/${c.body.id}`, { hack: 1 })).status, 400);
    assert.equal((await call('DELETE', `/api/kols/${c.body.id}`)).status, 200);
    assert.equal((await call('DELETE', `/api/kols/${c.body.id}`)).status, 404);
  });

  test('engine control: shadow, kill, re-arm rules', async () => {
    assert.equal((await call('POST', '/api/engine/control', { action: 'shadow_mode' })).body.status, 'SHADOW');
    assert.equal((await call('POST', '/api/engine/control', { action: 'emergency_kill_switch', reason: 'test' })).body.status, 'KILLED');
    assert.equal((await call('POST', '/api/engine/control', { action: 'start' })).status, 409);
    assert.equal((await call('POST', '/api/engine/control', { action: 'pause' })).body.status, 'PAUSED');
    assert.equal((await call('POST', '/api/engine/control', { action: 'start' })).body.status, 'RUNNING');
  });

  test('manual sell: pct validation, unknown mint, audited sell', async () => {
    assert.equal((await call('POST', `/api/positions/${randomPubkey()}/sell`, { pct: 20 })).status, 400);
    assert.equal((await call('POST', `/api/positions/${randomPubkey()}/sell`, { pct: 25 })).status, 404);
    let open: { mint: string }[] = [];
    for (let i = 0; i < 60 && !open.length; i++) { await sleep(500); open = (await call('GET', '/api/positions')).body.open; }
    assert.ok(open.length, 'simulator should open a position within 30 s');
    const r = await call('POST', `/api/positions/${open[0].mint}/sell`, { pct: 33 });
    assert.equal(r.status, 200);
    assert.ok((await call('GET', '/api/audit?limit=10')).body.items.some((a: { action: string; target: string }) => a.action === 'position.sell' && a.target === open[0].mint));
  });

  test('bursts: cursor pagination and filters', async () => {
    const p1 = (await call('GET', '/api/bursts?limit=5')).body;
    assert.equal(p1.items.length, 5);
    assert.ok(p1.nextCursor);
    const p2 = (await call('GET', `/api/bursts?limit=5&cursor=${p1.nextCursor}`)).body;
    assert.ok(p2.items.every((b: { id: string }) => !p1.items.some((x: { id: string }) => x.id === b.id)));
    const filled = (await call('GET', '/api/bursts?limit=20&outcome=filled')).body.items;
    assert.ok(filled.every((b: { outcome: string }) => b.outcome === 'filled'));
    assert.equal((await call('GET', '/api/bursts?outcome=bogus')).status, 400);
  });

  test('treasury and nonces', async () => {
    const t = (await call('GET', '/api/treasury')).body;
    assert.ok(t.balances.wsol > 0 && Array.isArray(t.sweeps) && Array.isArray(t.inventory));
    const n = (await call('GET', '/api/nonces')).body;
    assert.ok(n.pool.length >= 1);
    assert.equal((await call('POST', '/api/nonces', { action: 'advance' })).status, 400);
    assert.equal((await call('POST', '/api/nonces', { action: 'advance', pubkey: n.pool[0].pubkey })).status, 200);
    assert.equal((await call('POST', '/api/nonces', { action: 'check' })).status, 200);
  });

  test('websocket: auth required, telemetry flows', async () => {
    const url = s.base.replace('http', 'ws') + '/ws/telemetry';
    const bad = new WebSocket(url, { headers: { origin: 'http://localhost:3000' } });
    const code = await new Promise<number>((r) => { bad.on('open', () => bad.send(JSON.stringify({ type: 'auth', token: 'nope' }))); bad.on('close', (c) => r(c)); });
    assert.equal(code, 4401);
    const evil = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
    await new Promise<void>((r) => { evil.on('error', () => r()); evil.on('close', () => r()); });

    const ws = new WebSocket(url, { headers: { origin: 'http://localhost:3000' } });
    const seen = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; saw ${[...seen]}`)), 15_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: jwt })));
      ws.on('message', (m) => { seen.add(JSON.parse(String(m)).type); if (seen.has('ready') && seen.has('slot_tick') && seen.has('burst_dispatched')) { clearTimeout(t); resolve(); } });
    });
    ws.close();
  });

  test('circuit breaker: hourly burn cap pauses the engine', async () => {
    const cur = (await call('GET', '/api/config')).body;
    const next = structuredClone(cur.config); next.landers.max_hourly_burn_sol = 0.001;
    assert.equal((await call('PUT', '/api/config', { baseVersion: cur.version, config: next })).status, 200);
    await call('POST', '/api/engine/control', { action: 'start' });
    let tripped = false;
    for (let i = 0; i < 60 && !tripped; i++) {
      await sleep(500);
      tripped = (await call('GET', '/api/audit?limit=20')).body.items.some((a: { action: string }) => a.action === 'breaker.trip');
    }
    assert.ok(tripped, 'breaker should trip');
    assert.equal((await call('GET', '/api/state')).body.engine.status, 'PAUSED');
  });

  test('logout revokes the token', async () => {
    const t = (await call('POST', '/api/auth/login', { token: OP_TOKEN }, '')).body.token;
    assert.equal((await call('POST', '/api/auth/logout', {}, t)).status, 200);
    assert.equal((await call('GET', '/api/kols', undefined, t)).status, 401);
  });

  test('rate limit on login', async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call('POST', '/api/auth/login', { token: 'wrong-token-wrong-token' }, '')).status;
    assert.equal(last, 429);
  });
});

describe('ip allowlist', () => {
  test('blocks addresses outside the list', async () => {
    const b = await boot({ WHAL_IP_ALLOWLIST: '10.0.0.0/8' });
    try { assert.equal((await fetch(b.base + '/api/health')).status, 403); } finally { b.stop(); }
  });
});

export type { Env };

// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomPubkey } from '../pubkey';
import { DEFAULT_CONFIG, diffConfig, exportConfig, importConfig, needsRestart, validateConfig, type BotConfig } from './schema';

function valid(): BotConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.wallets.hot_wallet_pubkey = randomPubkey();
  c.wallets.wsol_vault_ata = randomPubkey();
  c.wallets.nonce_accounts = Array.from({ length: 8 }, () => randomPubkey());
  for (const p of Object.values(c.landers.providers)) p.tip_accounts = [randomPubkey()];
  return c;
}

test('valid config passes', () => assert.equal(validateConfig(valid()).ok, true));

test('factory defaults require wallet setup', () => {
  const r = validateConfig(DEFAULT_CONFIG);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors['wallets.hot_wallet_pubkey']);
});

test('cross-field rules', () => {
  const c = valid();
  c.strategy.min_buy_sol = 5; c.strategy.max_buy_sol = 1;
  c.strategy.buy_slot_ttl = { min: 4, max: 1 };
  c.landers.providers.jito.min_tip_sol = 0.05; c.landers.providers.jito.max_tip_sol = 0.01;
  c.treasury.clip_wsol = 500;
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  if (r.ok) return;
  for (const k of ['strategy.max_buy_sol', 'strategy.buy_slot_ttl.max', 'landers.providers.jito.max_tip_sol', 'treasury.clip_wsol']) assert.ok(r.errors[k], k);
});

test('credentials in URLs are rejected', () => {
  const c = valid();
  c.network.rpc_primary_url = 'https://rpc.example.com/?api-key=abc';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors['network.rpc_primary_url'], /secret/);
});

test('export strips secrets and import round-trips', () => {
  const c = valid();
  const json = JSON.parse(exportConfig(c));
  json.network.geyser_token = 'leaked';
  json.wallets.private_key = 'leaked';
  const r = importConfig(JSON.stringify(json));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.stripped.sort(), ['network.geyser_token', 'wallets.private_key']);
  assert.deepEqual(r.config, c);
});

test('diff marks restart-required paths', () => {
  const a = valid(), b = structuredClone(a);
  b.strategy.slippage_bps = 900;
  b.network.commitment = 'confirmed';
  const d = diffConfig(a, b);
  assert.deepEqual(d.map((x) => [x.path, x.restart]), [['network.commitment', true], ['strategy.slippage_bps', false]]);
  assert.equal(needsRestart('landers.providers.jito.endpoint_url'), true);
  assert.equal(needsRestart('landers.providers.jito.max_tip_sol'), false);
});

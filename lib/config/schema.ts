// Bot configuration: single source of truth for the frontend (Zod v4).
// Mirrors engine/whal-config (Rust serde). JSON Schema is generated from this file:
//   npm run config:schema  ->  config/bot-config.schema.json
//
// Secrets (API tokens, signer key) are NOT part of this object. They live in the engine's
// encrypted secret store and are referenced by id (see SECRETS). Export/import never carries them.
import { z } from 'zod';
import { isPubkey } from '@/lib/pubkey';

export const CONFIG_VERSION = 1;
export const LANDER_IDS = ['jito', 'nozomi', 'stellium', 'landx', 'bloom', 'astralane', 'glaive', 'fastlanes', 'tpu'] as const;
export type LanderKey = (typeof LANDER_IDS)[number];
export const LANDER_LABEL: Record<LanderKey, string> = {
  jito: 'Jito', nozomi: 'Temporal / Nozomi', stellium: 'Stellium', landx: 'LandX', bloom: 'Bloom / BlockRazor', astralane: 'Astralane', glaive: 'Glaive', fastlanes: 'Speed / FastLanes', tpu: 'Direct TPU',
};

const LAMPORTS = 1_000_000_000;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------- primitives ----------
const pubkey = z.string().trim().refine(isPubkey, 'Not a valid Solana public key (base58, 32 bytes)');
const CRED_PARAM = /^(api[-_]?key|apikey|token|key|secret|auth|access[-_]?token)$/i;
/** URL that must not embed credentials: tokens belong in the secret store. */
const endpoint = (protocols: string[]) =>
  z.string().trim().superRefine((v, ctx) => {
    let u: URL;
    try { u = new URL(v); } catch { ctx.addIssue({ code: 'custom', message: 'Not a valid URL' }); return; }
    if (!protocols.includes(u.protocol)) ctx.addIssue({ code: 'custom', message: `Must start with ${protocols.map((p) => `${p}//`).join(' or ')}` });
    if (u.username || u.password) ctx.addIssue({ code: 'custom', message: 'Remove credentials from the URL; set them as a secret instead' });
    for (const k of u.searchParams.keys()) if (CRED_PARAM.test(k)) ctx.addIssue({ code: 'custom', message: `Remove "${k}" from the URL; set it as a secret instead` });
  });
const httpUrl = endpoint(['https:', 'http:']);
const grpcUrl = endpoint(['https:', 'http:', 'grpc:', 'grpcs:']);
const sol = (min: number, max: number) => z.number({ error: 'Enter a number' }).min(min, `At least ${min} SOL`).max(max, `At most ${max} SOL`);
const int = (min: number, max: number, unit = '') => z.number({ error: 'Enter a number' }).int('Whole numbers only').min(min, `At least ${min}${unit}`).max(max, `At most ${max}${unit}`);
const bps = int(0, 5_000, ' bps');
const pct = z.number({ error: 'Enter a number' }).gt(0, 'Above 0%').max(100, 'At most 100%');
const slotRange = (maxSlots: number) =>
  z.object({ min: int(0, maxSlots, ' slots'), max: int(0, maxSlots, ' slots') })
    .refine((r) => r.min <= r.max, { message: 'Min must be ≤ max', path: ['max'] });

// ---------- sections ----------
export const NetworkSchema = z.object({
  rpc_primary_url: httpUrl,
  rpc_backup_urls: z.array(httpUrl).max(4, 'At most 4 backups'),
  geyser_grpc_url: grpcUrl,
  shredstream_url: grpcUrl,
  commitment: z.enum(['processed', 'confirmed', 'finalized']),
  slot_clock_offset_ms: int(-2_000, 2_000, ' ms'),
});

export const WalletsSchema = z.object({
  hot_wallet_pubkey: pubkey,
  signer_source: z.enum(['encrypted_keystore', 'remote_signer']),
  wsol_vault_ata: pubkey,
  nonce_accounts: z.array(pubkey).max(32, 'At most 32 nonce accounts')
    .refine((xs) => new Set(xs).size === xs.length, 'Duplicate nonce account'),
  nonce_auto_create: z.boolean(),
  nonce_target_pool_size: int(1, 32),
  nonce_health_check_secs: int(5, 3_600, ' s'),
  nonce_min_balance_sol: sol(0.0015, 1),
  max_hot_wallet_sol: sol(0.1, 10_000),
}).superRefine((w, ctx) => {
  if (w.hot_wallet_pubkey && w.hot_wallet_pubkey === w.wsol_vault_ata) ctx.addIssue({ code: 'custom', path: ['wsol_vault_ata'], message: 'The WSOL vault is a token account, not the wallet itself' });
  if (w.nonce_accounts.includes(w.hot_wallet_pubkey)) ctx.addIssue({ code: 'custom', path: ['nonce_accounts'], message: 'The hot wallet cannot be a nonce account' });
  if (!w.nonce_auto_create && w.nonce_accounts.length === 0) ctx.addIssue({ code: 'custom', path: ['nonce_accounts'], message: 'Add at least one nonce account or enable Auto-create' });
});

export const StrategySchema = z.object({
  modes: z.object({ kol_backrun: z.boolean(), pumpfun_create_snipe: z.boolean(), generic_quote_snipe: z.boolean() }),
  default_buy_sol: sol(0.01, 100),
  min_buy_sol: sol(0.01, 100),
  max_buy_sol: sol(0.01, 100),
  max_curve_reserve_sol: sol(1, 100_000),
  slippage_bps: bps,
  default_kol_margin_sol: sol(0.000_001, 10),
  buy_slot_ttl: slotRange(16),
  generic_quote_mints: z.array(pubkey).max(64),
}).superRefine((s, ctx) => {
  if (s.min_buy_sol > s.max_buy_sol) ctx.addIssue({ code: 'custom', path: ['max_buy_sol'], message: 'Max must be ≥ min' });
  if (s.default_buy_sol < s.min_buy_sol || s.default_buy_sol > s.max_buy_sol) ctx.addIssue({ code: 'custom', path: ['default_buy_sol'], message: 'Default must sit between min and max' });
  if (s.modes.generic_quote_snipe && s.generic_quote_mints.length === 0) ctx.addIssue({ code: 'custom', path: ['generic_quote_mints'], message: 'Add at least one quote mint for Generic-Quote mode' });
});

export const ProviderSchema = z.object({
  enabled: z.boolean(),
  endpoint_url: httpUrl,
  tip_accounts: z.array(pubkey).max(16, 'At most 16 tip accounts'),
  min_tip_sol: sol(0, 1),
  max_tip_sol: sol(0, 1),
  fanout: int(0, 32, ' txs'),
}).superRefine((p, ctx) => {
  if (p.min_tip_sol > p.max_tip_sol) ctx.addIssue({ code: 'custom', path: ['max_tip_sol'], message: 'Max tip must be ≥ min tip' });
  if (p.enabled && p.fanout === 0) ctx.addIssue({ code: 'custom', path: ['fanout'], message: 'Enabled providers need a fan-out of at least 1' });
});

export const LandersSchema = z.object({
  providers: z.object(Object.fromEntries(LANDER_IDS.map((id) => [id, ProviderSchema])) as Record<LanderKey, typeof ProviderSchema>),
  tx: z.object({
    version: z.enum(['v1', 'v0', 'legacy']),
    compute_unit_limit: int(1_000, 1_400_000, ' CU'),
    loaded_accounts_data_size_limit: int(0, 64 * 1024 * 1024, ' bytes'),
    priority_fee_lamports: int(0, 1 * LAMPORTS, ' lamports'),
  }),
  max_hourly_burn_sol: sol(0.001, 1_000),
}).superRefine((l, ctx) => {
  const on = LANDER_IDS.filter((id) => l.providers[id].enabled);
  if (on.length === 0) ctx.addIssue({ code: 'custom', path: ['providers'], message: 'Enable at least one landing provider' });
  const total = on.reduce((a, id) => a + l.providers[id].fanout, 0);
  if (total > 128) ctx.addIssue({ code: 'custom', path: ['providers'], message: `Total fan-out ${total} exceeds 128 txs per opportunity` });
  for (const id of on) if (id !== 'tpu' && l.providers[id].tip_accounts.length === 0) ctx.addIssue({ code: 'custom', path: ['providers', id, 'tip_accounts'], message: 'Add the provider’s tip accounts' });
});

const LadderStep = z.object({
  sell_pct: pct,
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pnl_multiple'), value: z.number().gt(0, 'Above 0').max(1_000) }),
    z.object({ kind: z.literal('time_secs'), value: int(1, 86_400, ' s') }),
  ]),
});

export const ExitsSchema = z.object({
  instant_tp_pct: z.number().min(0, '0% disables it').max(100),
  ladder: z.array(LadderStep).max(8, 'At most 8 steps'),
  stop_loss_pct: z.number().min(0).max(99, 'At most 99%').nullable(),
  trailing_stop_pct: z.number().min(0).max(99, 'At most 99%').nullable(),
  curve_floor: z.object({ enabled: z.boolean(), min_real_sol_reserves_sol: sol(0, 100_000) }),
  sell_slot_ttl: slotRange(64),
  auto_close_account: z.boolean(),
}).superRefine((x, ctx) => {
  const mult = x.ladder.filter((s) => s.trigger.kind === 'pnl_multiple').map((s) => s.trigger.value);
  if (mult.some((v, i) => i > 0 && v <= mult[i - 1])) ctx.addIssue({ code: 'custom', path: ['ladder'], message: 'PnL-multiple triggers must increase step by step' });
});

export const TreasurySchema = z.object({
  sweep_enabled: z.boolean(),
  trigger_wsol_threshold: sol(1, 1_000_000),
  clip_wsol: sol(0.1, 10_000),
  target_mint: pubkey,
  route: z.enum(['jupiter_v6']),
  slippage_bps: bps,
  max_priority_fee_lamports: int(0, 0.1 * LAMPORTS, ' lamports'),
}).refine((t) => t.clip_wsol <= t.trigger_wsol_threshold, { path: ['clip_wsol'], message: 'Clip must not exceed the trigger threshold' });

export const BotConfigSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  network: NetworkSchema,
  wallets: WalletsSchema,
  strategy: StrategySchema,
  landers: LandersSchema,
  exits: ExitsSchema,
  treasury: TreasurySchema,
}).strict();

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type SectionKey = Exclude<keyof BotConfig, 'version'>;

// ---------- secrets (write-only, encrypted at rest by the engine) ----------
export interface SecretMeta { id: string; label: string; section: SectionKey; uiSettable: boolean; hint?: string }
export const SECRETS: SecretMeta[] = [
  { id: 'network.rpc_api_key', label: 'RPC API key', section: 'network', uiSettable: true, hint: 'Sent as a header to the primary and backup RPCs.' },
  { id: 'network.geyser_token', label: 'Geyser gRPC token', section: 'network', uiSettable: true },
  { id: 'network.shredstream_token', label: 'ShredStream auth token', section: 'network', uiSettable: true },
  { id: 'wallets.hot_wallet_keypair', label: 'Hot wallet signer key', section: 'wallets', uiSettable: false,
    hint: 'Never entered in the browser. Import it on the engine host: whal-engine secrets import-keypair <path>' },
  ...LANDER_IDS.filter((id) => id !== 'tpu').map((id): SecretMeta => ({ id: `landers.${id}.auth_token`, label: `${LANDER_LABEL[id]} auth token`, section: 'landers', uiSettable: true })),
];
export interface SecretStatus { set: boolean; updatedAt: number | null }

// ---------- hot reload ----------
/** Paths whose change needs an engine restart. Everything else is applied live. */
export const RESTART_REQUIRED = [
  'network.rpc_primary_url', 'network.rpc_backup_urls', 'network.geyser_grpc_url', 'network.shredstream_url', 'network.commitment',
  'wallets.hot_wallet_pubkey', 'wallets.signer_source', 'wallets.wsol_vault_ata',
  ...LANDER_IDS.map((id) => `landers.providers.${id}.endpoint_url`),
  'landers.tx.version',
];
export const needsRestart = (path: string) => RESTART_REQUIRED.some((p) => path === p || path.startsWith(p + '.') || path.startsWith(p + '['));

// ---------- defaults ----------
const provider = (enabled: boolean, url: string, tip: [number, number], fanout: number): z.infer<typeof ProviderSchema> =>
  ({ enabled, endpoint_url: url, tip_accounts: [], min_tip_sol: tip[0], max_tip_sol: tip[1], fanout });

export const DEFAULT_CONFIG: BotConfig = {
  version: CONFIG_VERSION,
  network: {
    rpc_primary_url: 'https://rpc.example-provider.com',
    rpc_backup_urls: [],
    geyser_grpc_url: 'https://grpc.example-provider.com:443',
    shredstream_url: 'grpc://127.0.0.1:9999',
    commitment: 'processed',
    slot_clock_offset_ms: 0,
  },
  wallets: {
    hot_wallet_pubkey: '',
    signer_source: 'encrypted_keystore',
    wsol_vault_ata: '',
    nonce_accounts: [],
    nonce_auto_create: true,
    nonce_target_pool_size: 8,
    nonce_health_check_secs: 30,
    nonce_min_balance_sol: 0.0015,
    max_hot_wallet_sol: 50,
  },
  strategy: {
    modes: { kol_backrun: true, pumpfun_create_snipe: false, generic_quote_snipe: false },
    default_buy_sol: 0.5, min_buy_sol: 0.1, max_buy_sol: 8,
    max_curve_reserve_sol: 60, slippage_bps: 800, default_kol_margin_sol: 0.02,
    buy_slot_ttl: { min: 0, max: 4 },
    generic_quote_mints: [],
  },
  landers: {
    providers: {
      jito: provider(false, 'https://mainnet.block-engine.jito.wtf', [0.001, 0.01], 8),
      nozomi: provider(false, 'https://nozomi.temporal.xyz', [0.001, 0.011], 16),
      stellium: provider(false, 'https://stellium.example', [0.011, 0.011], 16),
      landx: provider(false, 'https://landx.example', [0.011, 0.011], 16),
      bloom: provider(false, 'https://bloom.blockrazor.example', [0.0001, 0.07], 12),
      astralane: provider(false, 'https://astralane.example', [0.0001, 0.001], 8),
      glaive: provider(false, 'https://glaive.example', [0.0001, 0.0011], 8),
      fastlanes: provider(false, 'https://fastlanes.example', [0.0001, 0.0001], 8),
      tpu: provider(true, 'https://tpu-forwarder.local', [0, 0], 4),
    },
    tx: { version: 'v1', compute_unit_limit: 200_000, loaded_accounts_data_size_limit: 262_144, priority_fee_lamports: 50_000 },
    max_hourly_burn_sol: 5,
  },
  exits: {
    instant_tp_pct: 25,
    ladder: [
      { sell_pct: 15, trigger: { kind: 'pnl_multiple', value: 2 } },
      { sell_pct: 33, trigger: { kind: 'pnl_multiple', value: 3 } },
      { sell_pct: 100, trigger: { kind: 'time_secs', value: 1_800 } },
    ],
    stop_loss_pct: 30,
    trailing_stop_pct: null,
    curve_floor: { enabled: true, min_real_sol_reserves_sol: 5 },
    sell_slot_ttl: { min: 7, max: 9 },
    auto_close_account: true,
  },
  treasury: {
    sweep_enabled: true, trigger_wsol_threshold: 140, clip_wsol: 20, target_mint: USDC_MINT,
    route: 'jupiter_v6', slippage_bps: 30, max_priority_fee_lamports: 25_000,
  },
};

// ---------- validation helpers ----------
export type FieldErrors = Record<string, string>;
export const issuePath = (path: PropertyKey[]) => path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');

export function validateConfig(input: unknown): { ok: true; config: BotConfig } | { ok: false; errors: FieldErrors } {
  const r = BotConfigSchema.safeParse(input);
  if (r.success) return { ok: true, config: r.data };
  const errors: FieldErrors = {};
  for (const i of r.error.issues) errors[issuePath(i.path)] ??= i.message;
  return { ok: false, errors };
}

/** Keys that look like credentials. Used to strip and warn on import. */
const SECRET_KEY = /(token|secret|private|keypair|api[-_]?key|password|seed|mnemonic)/i;

export function stripSecrets(value: unknown, path = '', removed: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v, i) => stripSecrets(v, `${path}[${i}]`, removed));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k) && k !== 'tip_accounts') { removed.push(p); continue; }
      out[k] = stripSecrets(v, p, removed);
    }
    return out;
  }
  return value;
}

export function exportConfig(c: BotConfig) {
  return JSON.stringify({ $schema: './bot-config.schema.json', ...(stripSecrets(c) as object) }, null, 2);
}

export function importConfig(text: string): { ok: true; config: BotConfig; stripped: string[] } | { ok: false; error: string; errors?: FieldErrors } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'That file is not valid JSON.' }; }
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  const stripped: string[] = [];
  const clean = stripSecrets(raw, '', stripped) as Record<string, unknown>;
  delete clean.$schema;
  const v = validateConfig(clean);
  if (!v.ok) return { ok: false, error: `The file has ${Object.keys(v.errors).length} invalid field(s).`, errors: v.errors };
  return { ok: true, config: v.config, stripped };
}

// ---------- diff ----------
export interface ConfigChange { path: string; before: unknown; after: unknown; restart: boolean }

export function diffConfig(a: unknown, b: unknown, path = ''): ConfigChange[] {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (same) return [];
  const isObj = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diffConfig((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return [{ path, before: a, after: b, restart: needsRestart(path) }];
}

export function toJsonSchema() {
  return z.toJSONSchema(BotConfigSchema, { target: 'draft-2020-12' });
}

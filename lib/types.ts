// Domain types shared by the mock socket today and the live API in Step 2.
import type { BotConfig, SecretStatus } from '@/lib/config/schema';

export type EngineStatus = 'RUNNING' | 'PAUSED' | 'SHADOW' | 'KILLED';
export type QuoteAsset = 'SOL' | 'WSOL' | 'USDC' | 'BONK';
export type Venue = 'Pump.fun' | 'PumpSwap' | 'Raydium LaunchLab' | 'Raydium CPMM';
export type LanderId = 'jito' | 'nozomi' | 'stellium' | 'landx' | 'bloom' | 'astralane' | 'glaive' | 'fastlanes' | 'tpu';

export interface ChainHealth {
  slot: number;
  shredLatencyMs: number;
  nonces: { ready: number; total: number };
  ring: { used: number; size: number };
}

export interface Balances {
  sol: number;
  wsol: number;
  usdc: number;
  solUsd: number;
}

export interface RevertBreakdown {
  duplicate: number; // ring-buffer dedupe hit
  mutex: number; // seeded-account mutex already in use
  kolNotLanded: number; // balance-delta guard
  slippage: number;
  expired: number; // slot TTL passed
}

export type FeedKind = 'kol_buy' | 'launch' | 'sell';
export type FeedOutcome = 'filled' | 'missed' | 'expired' | 'shadow' | 'sold';

export interface FeedEvent {
  id: string;
  ts: number;
  slot: number;
  kind: FeedKind;
  kolId: string | null;
  mint: string;
  symbol: string;
  image?: string;
  venue: Venue;
  sizeSol: number;
  fanout: number; // txs sent for this opportunity
  winner: LanderId | null;
  cuUsed: number; // total compute units across the burst
  reverts: RevertBreakdown;
  outcome: FeedOutcome;
  note?: string;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  image?: string;
  venue: Venue;
  kolId: string | null;
  openedAt: number;
  openedSlot: number;
  entrySol: number; // SOL spent on entry
  initialTokens: number;
  tokens: number;
  entryPrice: number; // SOL per token
  price: number; // SOL per token, current mark
  realizedSol: number;
  proceedsSol?: number;
  pendingSell: number | null; // pct in flight
}

export interface ClosedPosition {
  id: string;
  mint: string;
  symbol: string;
  image?: string;
  venue: Venue;
  kolId: string | null;
  openedAt: number;
  closedAt: number;
  entrySol: number;
  proceedsSol: number;
  solUsd: number; // SOL/USD at close, for USD display
  exitReason: string;
  buySlot?: number | null;
  slotDelta?: number | null;
}

export interface KolStats {
  wins: number;
  losses: number;
  realizedSol: number;
  lastSeenSlot: number | null;
}

export interface Kol {
  id: string;
  label: string;
  pubkey: string;
  quote: QuoteAsset;
  triggerMargin: number; // in quote units
  buySizeSol: number;
  maxCurveReserveSol: number;
  enabled: boolean;
  stats: KolStats;
}

export interface LanderStat {
  id: LanderId;
  name: string;
  enabled: boolean;
  sent: number;
  wins: number;
  slotDeltaSum: number; // sum of (landed slot - trigger slot) over wins
  tipPaidSol: number;
  revertCostSol: number;
}

export interface Sweep {
  id: string;
  ts: number;
  slot: number;
  wsolIn: number;
  usdcOut: number;
  route: string;
  status: 'confirmed' | 'pending' | 'failed';
}

export interface InventoryItem {
  mint: string;
  symbol: string;
  name: string;
  program: 'SPL' | 'Token-2022';
  kind: 'xStock' | 'Stablecoin' | 'Meme' | 'Wrapped';
  amount: number;
  priceUsd: number;
}

export interface RentStats {
  accountsClosed: number;
  reclaimedSol: number;
  openSeededAccounts: number;
  rentPerAccountSol: number;
}

export interface NonceHealth { pubkey: string; status: 'ready' | 'in_use' | 'low_balance' | 'missing'; balanceSol: number; lastCheckedAt: number }

export interface ConfigState {
  version: number;
  config: BotConfig;
  secrets: Record<string, SecretStatus>;
  pendingRestart: string[];
  updatedAt: number;
  nonces: NonceHealth[];
}

export interface ConfigApplyResult { version: number; appliedLive: string[]; pendingRestart: string[] }

export interface TerminalState {
  connection: 'connecting' | 'open' | 'reconnecting' | 'closed';
  source: 'mock' | 'live';
  /** Which engine is behind the data: in-browser mock, control plane's simulator, the real engine bridge, or none. */
  engineSource?: 'mock' | 'simulated' | 'bridge' | 'disconnected';
  lastMessageAt: number | null;
  engine: { status: EngineStatus; changedAt: number; reason?: string };
  chain: ChainHealth;
  balances: Balances;
  feed: FeedEvent[];
  positions: Position[];
  closed: ClosedPosition[];
  kols: Kol[];
  landers: LanderStat[];
  sweeps: Sweep[];
  inventory: InventoryItem[];
  rent: RentStats;
  session: { startedAt: number; bursts: number; fills: number; txSent: number; realizedSol: number };
  config: ConfigState | null;
}

// ---- wire protocol ----
export type ServerMessage =
  | { type: 'snapshot'; state: Omit<TerminalState, 'connection' | 'lastMessageAt'> }
  | { type: 'chain'; chain: ChainHealth; balances: Balances }
  | { type: 'feed'; event: FeedEvent }
  | { type: 'positions'; positions: Position[]; closed: ClosedPosition[] }
  | { type: 'kols'; kols: Kol[] }
  | { type: 'landers'; landers: LanderStat[] }
  | { type: 'treasury'; sweeps: Sweep[]; inventory: InventoryItem[]; rent: RentStats }
  | { type: 'engine'; status: EngineStatus; changedAt: number; reason?: string }
  | { type: 'session'; session: TerminalState['session'] }
  | { type: 'config'; config: ConfigState }
  | { type: 'ack'; id: string; ok: boolean; error?: string; fields?: Record<string, string>; result?: unknown };

export type ClientCommand =
  | { type: 'engine.set'; status: Exclude<EngineStatus, 'KILLED'> }
  | { type: 'engine.kill'; reason: string }
  | { type: 'position.sell'; positionId: string; pct: 15 | 25 | 33 | 50 | 100 }
  | { type: 'kol.upsert'; kol: Omit<Kol, 'stats'> & { stats?: KolStats } }
  | { type: 'kol.toggle'; id: string; enabled: boolean }
  | { type: 'kol.remove'; id: string }
  | { type: 'config.update'; baseVersion: number; config: BotConfig }
  | { type: 'secret.set'; id: string; value: string }
  | { type: 'secret.clear'; id: string }
  | { type: 'nonce.create'; count: number }
  | { type: 'nonce.topup' }
  | { type: 'nonce.check' }
  | { type: 'nonce.advance'; pubkey: string };

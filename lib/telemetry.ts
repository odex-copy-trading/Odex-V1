// Telemetry contract for /ws/telemetry (control plane -> UI) and /internal/engine (engine -> control plane).
// The Rust engine emits the same JSON shapes over the bridge.
import type { BotConfig } from '@/lib/config/schema';
import type {
  Balances, ChainHealth, ClosedPosition, ConfigState, EngineStatus, FeedEvent, InventoryItem, Kol, LanderStat, Position, RentStats, Sweep, TerminalState,
} from '@/lib/types';

export type EngineSource = 'simulated' | 'bridge' | 'disconnected';

export type TelemetryEvent =
  | { type: 'slot_tick'; ts: number; chain: ChainHealth; balances: Balances }
  | { type: 'kol_shred_detected'; ts: number; slot: number; kolId: string | null; mint: string; symbol: string; venue: FeedEvent['venue'] }
  | { type: 'burst_dispatched'; ts: number; burst: FeedEvent }
  | { type: 'tx_landed'; ts: number; burstId: string; slot: number; outcome: FeedEvent['outcome']; lander: FeedEvent['winner']; signature: string | null }
  | { type: 'position_updated'; ts: number; positions: Position[]; closed?: ClosedPosition }
  | { type: 'sweep_executed'; ts: number; sweep: Sweep }
  | { type: 'treasury_updated'; ts: number; sweeps: Sweep[]; inventory: InventoryItem[]; rent: RentStats }
  | { type: 'circuit_breaker_tripped'; ts: number; breaker: 'hourly_burn' | 'hot_wallet_ceiling' | 'engine_disconnected' | 'manual'; reason: string }
  | { type: 'engine_status'; ts: number; status: EngineStatus; reason?: string; source: EngineSource }
  | { type: 'kols_updated'; ts: number; kols: Kol[] }
  | { type: 'landers_updated'; ts: number; landers: LanderStat[] }
  | { type: 'session_updated'; ts: number; session: TerminalState['session'] }
  | { type: 'config_updated'; ts: number; config: ConfigState };

export type TelemetryType = TelemetryEvent['type'];

/** Snapshot served by GET /api/state so the UI can paint before the first WS event. */
export type StateSnapshot = Omit<TerminalState, 'connection' | 'lastMessageAt'> & { engineSource: EngineSource };

/** Client -> server messages on /ws/telemetry. */
export type WsClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; events: TelemetryType[] | '*' }
  | { type: 'ping' };

/** Server -> client control messages on /ws/telemetry (in addition to TelemetryEvent). */
export type WsServerControl =
  | { type: 'ready'; engineSource: EngineSource }
  | { type: 'error'; error: string }
  | { type: 'pong'; ts: number };

export const SELL_PCTS = [15, 25, 33, 50, 100] as const;
export type SellPct = (typeof SELL_PCTS)[number];
export type { BotConfig };

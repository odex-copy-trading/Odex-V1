// Contract between the control plane and a trading engine (simulated, or the Rust engine over the bridge).
import type { BotConfig } from '../../lib/config/schema';
import type { EngineSource, SellPct, TelemetryEvent } from '../../lib/telemetry';
import type { Kol, NonceHealth, TerminalState } from '../../lib/types';

export interface BridgeTriggerPayload {
  kind: 'kol_buy' | 'launch';
  venue: 'Pump.fun' | 'PumpSwap' | 'Raydium LaunchLab' | 'Raydium CPMM';
  mint: string;
  poolPda: string;
  slot: number;
  buySizeSol: number;
  maxCurveReserveSol: number;
  kolId?: string;
  kolWallet?: string;
  creator?: string;
  devBuySol?: number;
  symbol?: string;
  name?: string;
  uri?: string;
  dexAccounts: string[];
}

export type EngineCommand =
  | { type: 'control'; status: 'RUNNING' | 'PAUSED' | 'SHADOW' }
  | { type: 'kill'; reason: string }
  | { type: 'sell'; mint: string; pct: SellPct }
  | { type: 'config.apply'; version: number; config: BotConfig }
  | { type: 'kol.upsert'; kol: Kol }
  | { type: 'kol.remove'; id: string }
  | { type: 'nonce'; action: 'create' | 'topup' | 'advance' | 'check'; count?: number; pubkey?: string }
  | { type: 'trigger.dispatch'; trigger: BridgeTriggerPayload };

/** Runtime state only the engine knows. Config, KOL rules and history belong to the control plane. */
export type EngineRuntime = Pick<TerminalState, 'engine' | 'chain' | 'balances' | 'feed' | 'positions' | 'closed' | 'landers' | 'sweeps' | 'inventory' | 'rent' | 'session'> & {
  nonces: NonceHealth[];
  kols: Kol[]; // engine-side stats (wins/losses/realized); rules come from the control plane
};

export type AdapterEvent = TelemetryEvent | { type: 'nonces'; nonces: NonceHealth[] } | { type: 'connected' } | { type: 'disconnected'; reason: string };

export interface EngineAdapter {
  readonly source: EngineSource;
  start(): void;
  stop(): void;
  /** Null until the engine has connected and sent a snapshot. */
  runtime(): EngineRuntime | null;
  command<R = unknown>(cmd: EngineCommand): Promise<R>;
  onEvent(cb: (e: AdapterEvent) => void): void;
}

export class EngineError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

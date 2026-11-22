// SIMULATED engine for development. Wraps the same simulator the UI used in Step 1 (lib/mock/server.ts),
// so nothing here touches a network, signs or sends a transaction. Its state is labelled
// engineSource="simulated" everywhere it surfaces.
import { randomBytes } from 'node:crypto';
import { MockTerminalServer } from '../../lib/mock/server';
import { encodeBase58 } from '../../lib/pubkey';
import type { ClientCommand, ServerMessage } from '../../lib/types';
import { EngineError, type AdapterEvent, type EngineAdapter, type EngineCommand, type EngineRuntime } from './types';

const fakeSig = () => encodeBase58(randomBytes(64));

export class SimulatedEngine implements EngineAdapter {
  readonly source = 'simulated' as const;
  private sim: MockTerminalServer;
  private listeners: ((e: AdapterEvent) => void)[] = [];
  private acks = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  private lastSweepStatus = new Map<string, string>();
  private seq = 0;

  constructor() {
    this.sim = new MockTerminalServer((m) => this.onSim(m));
  }

  start() { this.sim.start(); }
  stop() { this.sim.stop(); }
  onEvent(cb: (e: AdapterEvent) => void) { this.listeners.push(cb); }
  private emit(e: AdapterEvent) { for (const l of this.listeners) l(e); }

  runtime(): EngineRuntime {
    const s = this.sim.state;
    return structuredClone({
      engine: s.engine, chain: s.chain, balances: s.balances, feed: s.feed, positions: s.positions, closed: s.closed, landers: s.landers,
      sweeps: s.sweeps, inventory: s.inventory, rent: s.rent, session: s.session, nonces: s.config?.nonces ?? [], kols: s.kols,
    });
  }

  /** Simulator's seeded config + KOLs, used to bootstrap an empty control-plane database. */
  seed() { return { config: structuredClone(this.sim.state.config!.config), kols: structuredClone(this.sim.state.kols) }; }

  command<R>(cmd: EngineCommand): Promise<R> {
    const c = this.toClient(cmd);
    const id = `c${++this.seq}`;
    return new Promise<R>((resolve, reject) => {
      this.acks.set(id, { resolve: resolve as (r: unknown) => void, reject });
      setTimeout(() => { if (this.acks.delete(id)) reject(new EngineError('Engine did not acknowledge in time', 504)); }, 5000);
      this.sim.handle(id, c);
    });
  }

  private toClient(cmd: EngineCommand): ClientCommand {
    const s = this.sim.state;
    switch (cmd.type) {
      case 'control': return { type: 'engine.set', status: cmd.status };
      case 'kill': return { type: 'engine.kill', reason: cmd.reason };
      case 'sell': {
        const p = s.positions.find((x) => x.mint === cmd.mint);
        if (!p) throw new EngineError('No open position for that mint', 404);
        return { type: 'position.sell', positionId: p.id, pct: cmd.pct };
      }
      case 'config.apply': return { type: 'config.update', baseVersion: s.config!.version, config: cmd.config };
      case 'kol.upsert': return { type: 'kol.upsert', kol: cmd.kol };
      case 'kol.remove': return { type: 'kol.remove', id: cmd.id };
      case 'nonce':
        if (cmd.action === 'create') return { type: 'nonce.create', count: cmd.count ?? 1 };
        if (cmd.action === 'topup') return { type: 'nonce.topup' };
        if (cmd.action === 'advance') return { type: 'nonce.advance', pubkey: cmd.pubkey ?? '' };
        return { type: 'nonce.check' };
    }
  }

  private onSim(m: ServerMessage) {
    const ts = Date.now();
    switch (m.type) {
      case 'ack': {
        const p = this.acks.get(m.id);
        if (!p) return;
        this.acks.delete(m.id);
        if (m.ok) p.resolve(m.result); else p.reject(Object.assign(new EngineError(m.error ?? 'Rejected by engine', 422), { fields: m.fields }));
        return;
      }
      case 'chain': return this.emit({ type: 'slot_tick', ts, chain: m.chain, balances: m.balances });
      case 'feed': {
        const e = m.event;
        if (e.kind !== 'sell') {
          this.emit({ type: 'kol_shred_detected', ts: e.ts, slot: e.slot, kolId: e.kolId, mint: e.mint, symbol: e.symbol, venue: e.venue });
          this.emit({ type: 'burst_dispatched', ts, burst: e });
        }
        if (e.outcome === 'filled' || e.outcome === 'sold') this.emit({ type: 'tx_landed', ts, burstId: e.id, slot: e.slot, outcome: e.outcome, lander: e.winner, signature: fakeSig() });
        else if (e.kind === 'sell') this.emit({ type: 'burst_dispatched', ts, burst: e });
        return;
      }
      case 'positions': {
        const prev = new Set(this.sim.state.closed.slice(1).map((c) => c.id));
        const newest = m.closed[0] && !prev.has(m.closed[0].id) && ts - m.closed[0].closedAt < 2000 ? m.closed[0] : undefined;
        return this.emit({ type: 'position_updated', ts, positions: m.positions, closed: newest });
      }
      case 'treasury': {
        for (const s of m.sweeps.slice(0, 3)) {
          if (s.status === 'confirmed' && this.lastSweepStatus.get(s.id) === 'pending') this.emit({ type: 'sweep_executed', ts, sweep: s });
          this.lastSweepStatus.set(s.id, s.status);
        }
        return this.emit({ type: 'treasury_updated', ts, sweeps: m.sweeps, inventory: m.inventory, rent: m.rent });
      }
      case 'engine': return this.emit({ type: 'engine_status', ts, status: m.status, reason: m.reason, source: 'simulated' });
      case 'kols': return this.emit({ type: 'kols_updated', ts, kols: m.kols });
      case 'landers': return this.emit({ type: 'landers_updated', ts, landers: m.landers });
      case 'session': return this.emit({ type: 'session_updated', ts, session: m.session });
      case 'config': return this.emit({ type: 'nonces', nonces: m.config.nonces });
      default: return;
    }
  }
}

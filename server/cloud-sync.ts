// Optional Supabase cloud persistence for Railway deployments without a mounted Volume.
// Restores config, KOL watchlist, closed trades, and Paper Mode on cold boot if local SQLite is empty,
// and mirrors mutations asynchronously so redeploys never wipe settings or history.
// Note: Secrets/private keys are NEVER sent to Supabase — they stay encrypted on the host.
import type { BotConfig } from '../lib/config/schema';
import type { ClosedPosition, Kol } from '../lib/types';
import type { Db } from './db';

export class CloudSync {
  private readonly baseUrl: string;
  private readonly key: string;
  readonly enabled: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = (env.WHAL_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
    this.key = (env.WHAL_SUPABASE_SERVICE_KEY || env.WHAL_SUPABASE_KEY || '').trim();
    this.enabled = Boolean(this.baseUrl && this.key);
  }

  private headers(prefer?: string): Record<string, string> {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    };
  }

  private async req<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T | null> {
    if (!this.enabled) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    try {
      const r = await fetch(`${this.baseUrl}/rest/v1/${path}`, {
        method,
        headers: this.headers(prefer),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok) return null;
      if (r.status === 204) return null;
      return (await r.json().catch(() => null)) as T | null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Restores config, KOLs, closed trades, and engine_mode from Supabase if local SQLite is fresh/empty. */
  async restoreIfEmpty(db: Db): Promise<boolean> {
    if (!this.enabled) return false;
    const latest = db.latestConfig();
    const hasLocalState =
      (latest && latest.version > 1) ||
      db.listKols().length > 0 ||
      db.listClosed(1).length > 0;
    if (hasLocalState) return false;

    try {
      const [cfgs, kols, closed, metas] = await Promise.all([
        this.req<Array<{ version: number; config: BotConfig; actor: string }>>('GET', 'config_versions?select=version,config,actor&order=version.desc&limit=1'),
        this.req<Array<{ id: string; label: string; pubkey: string; quote: Kol['quote']; trigger_margin: number; buy_size_sol: number; max_curve_reserve_sol: number; enabled: boolean; stats?: Kol['stats'] }>>('GET', 'kols?select=*'),
        this.req<Array<{ payload: ClosedPosition }>>('GET', 'closed_positions?select=payload&order=closed_at.desc&limit=500'),
        this.req<Array<{ key: string; value: string }>>('GET', 'meta?select=key,value'),
      ]);

      let restored = 0;
      if (Array.isArray(cfgs) && cfgs[0]?.config) {
        db.insertConfig(cfgs[0].version, cfgs[0].config, cfgs[0].actor || 'cloud-restore', []);
        restored++;
      }
      if (Array.isArray(kols) && kols.length) {
        for (const k of kols) {
          db.upsertKol({
            id: k.id,
            label: k.label,
            pubkey: k.pubkey,
            quote: k.quote,
            triggerMargin: k.trigger_margin,
            buySizeSol: k.buy_size_sol,
            maxCurveReserveSol: k.max_curve_reserve_sol,
            enabled: k.enabled,
            stats: k.stats ?? { wins: 0, losses: 0, realizedSol: 0, lastSeenSlot: null },
          });
        }
        restored += kols.length;
      }
      if (Array.isArray(closed) && closed.length) {
        for (const row of [...closed].reverse()) {
          if (row.payload?.id) db.insertClosed(row.payload);
        }
        restored += closed.length;
      }
      if (Array.isArray(metas) && metas.length) {
        for (const m of metas) db.setMeta(m.key, m.value);
        restored += metas.length;
      }
      if (restored > 0) {
        console.log(`[cloud-sync] Restored ${restored} persisted records from Supabase`);
      }
      return restored > 0;
    } catch {
      return false;
    }
  }

  syncConfig(version: number, config: BotConfig, actor: string) {
    if (!this.enabled) return;
    void this.req('POST', 'config_versions?on_conflict=version', { version, config, actor }, 'resolution=merge-duplicates,return=minimal');
  }

  syncKol(k: Kol) {
    if (!this.enabled) return;
    void this.req(
      'POST',
      'kols?on_conflict=id',
      {
        id: k.id,
        label: k.label,
        pubkey: k.pubkey,
        quote: k.quote,
        trigger_margin: k.triggerMargin,
        buy_size_sol: k.buySizeSol,
        max_curve_reserve_sol: k.maxCurveReserveSol,
        enabled: k.enabled,
        stats: k.stats,
        updated_at: new Date().toISOString(),
      },
      'resolution=merge-duplicates,return=minimal',
    );
  }

  deleteKol(id: string) {
    if (!this.enabled) return;
    void this.req('DELETE', `kols?id=eq.${encodeURIComponent(id)}`, undefined, 'return=minimal');
  }

  syncClosed(c: ClosedPosition) {
    if (!this.enabled) return;
    void this.req(
      'POST',
      'closed_positions?on_conflict=id',
      {
        id: c.id,
        mint: c.mint,
        symbol: c.symbol,
        venue: c.venue,
        closed_at: c.closedAt,
        cost_sol: c.entrySol,
        realized_sol: +(c.proceedsSol - c.entrySol).toFixed(6),
        reason: c.exitReason,
        payload: c,
      },
      'resolution=merge-duplicates,return=minimal',
    );
  }

  syncMeta(key: string, value: string) {
    if (!this.enabled) return;
    void this.req('POST', 'meta?on_conflict=key', { key, value }, 'resolution=merge-duplicates,return=minimal');
  }
}

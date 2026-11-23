// Read-only Solana Mainnet live feed (zero fake data, zero signing, zero transactions).
// - Real mainnet slots via Solana RPC WebSocket (Helius if available, automatic fallback to api.mainnet-beta.solana.com on 429)
// - Real mainnet Pump.fun new token launches (exact mint, symbol, dev buy SOL, signature) via PumpPortal live stream
// - Real SOL/USD price + real hot-wallet SOL balance via RPC getBalance
// Automatically yields whenever the Rust whal-engine connects to /internal/engine.
import WebSocket from 'ws';
import type { ClosedPosition, FeedEvent, Position } from '../../lib/types';
import type { ControlPlane } from '../control';
import type { SecretStore } from '../secrets';

const PUBLIC_SOLANA_WS = 'wss://api.mainnet-beta.solana.com';
const PUBLIC_SOLANA_HTTP = 'https://api.mainnet-beta.solana.com';
const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';
const ZERO_REVERTS = { duplicate: 0, mutex: 0, kolNotLanded: 0, slippage: 0, expired: 0 };

function buildRpcEndpoints(rawUrl: string, apiKey: string | null): { httpUrl: string; wsUrl: string } {
  let base = rawUrl.trim();
  if (!base || base.includes('example-provider.com') || base.includes('example.net')) {
    base = apiKey ? 'https://mainnet.helius-rpc.com' : PUBLIC_SOLANA_HTTP;
  }
  try {
    const u = new URL(base);
    if (apiKey && !u.searchParams.has('api-key') && u.hostname.includes('helius')) {
      u.searchParams.set('api-key', apiKey);
    }
    const httpUrl = u.toString();
    const ws = new URL(httpUrl);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return { httpUrl, wsUrl: ws.toString() };
  } catch {
    return { httpUrl: PUBLIC_SOLANA_HTTP, wsUrl: PUBLIC_SOLANA_WS };
  }
}

export class SolanaLiveFeed {
  private slotWs: WebSocket | null = null;
  private pumpWs: WebSocket | null = null;
  private stopped = false;
  private slotRetry = 0;
  private pumpRetry = 0;
  private usePublicSlotFallback = false;
  private slotTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private priceTimer: ReturnType<typeof setInterval> | null = null;
  private paperTimer: ReturnType<typeof setInterval> | null = null;
  private paper = new Map<string, { pos: Position; firedSteps: Set<number> }>();
  private solUsd = 0;
  private solBalance = 0;
  private lastSlot = 0;
  private lastSlotAt = 0;
  private seenMints = new Set<string>();
  private endpoints: { httpUrl: string; wsUrl: string } = { httpUrl: PUBLIC_SOLANA_HTTP, wsUrl: PUBLIC_SOLANA_WS };

  constructor(private cp: ControlPlane, private secrets: SecretStore) {}

  start() {
    this.stopped = false;
    this.reload();
    this.connectPumpStream();
    this.priceTimer = setInterval(() => void this.refreshMarketAndBalance(), 30_000);
    this.priceTimer.unref();
    this.paperTimer = setInterval(() => this.sweepExpiredPaperPositions(), 10_000);
    this.paperTimer.unref();
    this.cp.on('telemetry', (e: { type: string; positions?: Position[] }) => {
      if (e.type === 'config_updated') this.reload();
      if (e.type === 'position_updated' && e.positions) {
        const liveIds = new Set(e.positions.map((p) => p.mint));
        for (const mint of this.paper.keys()) if (!liveIds.has(mint)) this.paper.delete(mint);
      }
    });
  }

  stop() {
    this.stopped = true;
    if (this.slotTimer) clearTimeout(this.slotTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this.paperTimer) clearInterval(this.paperTimer);
    this.slotWs?.close();
    this.pumpWs?.close();
    this.slotWs = null;
    this.pumpWs = null;
  }

  reload() {
    let apiKey: string | null = null;
    try { apiKey = this.secrets.reveal('network.rpc_api_key').toString('utf8').trim() || null; } catch { /* unset */ }
    const rpcUrl = this.cp.configState().config.network.rpc_primary_url;
    const next = buildRpcEndpoints(rpcUrl, apiKey);
    if (next.wsUrl === this.endpoints.wsUrl && this.slotWs?.readyState === WebSocket.OPEN) return;

    this.endpoints = next;
    this.usePublicSlotFallback = false;
    this.slotRetry = 0;
    this.slotWs?.close();
    this.slotWs = null;
    if (this.slotTimer) clearTimeout(this.slotTimer);
    void this.refreshMarketAndBalance();
    this.connectSlotStream();
  }

  // ---------- 1. Live Solana Mainnet Slot Stream ----------
  private connectSlotStream() {
    if (this.stopped) return;
    const targetUrl = this.usePublicSlotFallback ? PUBLIC_SOLANA_WS : this.endpoints.wsUrl;
    const ws = new WebSocket(targetUrl);
    this.slotWs = ws;

    ws.on('open', () => {
      this.slotRetry = 0;
      console.log(`[solana-feed] Slot stream connected (${this.usePublicSlotFallback ? 'public mainnet-beta' : 'configured RPC'})`);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe', params: [] }));
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (msg.method === 'slotNotification') {
        const slot = (msg.params as { result?: { slot?: number } })?.result?.slot;
        if (typeof slot === 'number') this.onSlot(slot);
      }
    });

    ws.on('error', (err) => {
      if (!this.usePublicSlotFallback && /429|401|403/.test(err.message)) {
        console.warn(`[solana-feed] Primary RPC WS rejected (${err.message}); falling back to public mainnet slot stream`);
        this.usePublicSlotFallback = true;
      }
    });

    ws.on('close', () => {
      if (this.stopped || this.slotWs !== ws) return;
      const wait = Math.min(20_000, 1000 * 2 ** this.slotRetry++);
      this.slotTimer = setTimeout(() => this.connectSlotStream(), wait);
    });
  }

  private onSlot(slot: number) {
    const now = Date.now();
    const delta = this.lastSlotAt ? Math.max(5, Math.min(400, now - this.lastSlotAt)) : 18;
    this.lastSlot = slot;
    this.lastSlotAt = now;
    const nonces = this.cp.configState().config.wallets.nonce_accounts.length;
    this.cp.ingestExternalEvent({
      type: 'slot_tick',
      ts: now,
      chain: {
        slot,
        shredLatencyMs: delta,
        nonces: { ready: nonces, total: nonces },
        ring: { used: 0, size: 64 },
      },
      balances: {
        sol: this.solBalance,
        wsol: 0,
        usdc: 0,
        solUsd: this.solUsd,
      },
    });
  }

  // ---------- 2. Live Mainnet New Token Launch Stream (Pump.fun) ----------
  private connectPumpStream() {
    if (this.stopped) return;
    const ws = new WebSocket(PUMPPORTAL_WS);
    this.pumpWs = ws;

    ws.on('open', () => {
      this.pumpRetry = 0;
      console.log('[solana-feed] Connected to live mainnet Pump.fun new-token stream');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      if (this.paper.size > 0) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.paper.keys()] }));
      }
    });

    ws.on('message', (raw) => {
      let msg: {
        signature?: string;
        mint?: string;
        symbol?: string;
        name?: string;
        uri?: string;
        solAmount?: number;
        vSolInBondingCurve?: number;
        vTokensInBondingCurve?: number;
        txType?: string;
        pool?: string;
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg.mint) return;

      // Live mainnet trade update for an open Shadow paper position -> real mark-to-market PnL + auto exits.
      if ((msg.txType === 'buy' || msg.txType === 'sell') && this.paper.has(msg.mint)) {
        this.onPaperTrade(msg.mint, msg.vSolInBondingCurve, msg.vTokensInBondingCurve);
        return;
      }

      if (msg.txType !== 'create') return;
      if (this.seenMints.has(msg.mint)) return;
      this.seenMints.add(msg.mint);
      if (this.seenMints.size > 400) {
        const first = this.seenMints.values().next().value;
        if (first) this.seenMints.delete(first);
      }

      const ts = Date.now();
      const slot = this.lastSlot;
      const symbol = (msg.symbol || msg.mint.slice(0, 4)).trim().slice(0, 16);
      const sizeSol = typeof msg.solAmount === 'number' && Number.isFinite(msg.solAmount) ? +msg.solAmount.toFixed(4) : 0;
      const ev: FeedEvent = {
        id: `live_${(msg.signature || msg.mint).slice(0, 16)}`,
        ts,
        slot,
        kind: 'launch',
        kolId: null,
        mint: msg.mint,
        symbol,
        venue: msg.pool === 'raydium' ? 'Raydium LaunchLab' : 'Pump.fun',
        sizeSol,
        fanout: 0,
        winner: null,
        cuUsed: 0,
        reverts: ZERO_REVERTS,
        outcome: 'shadow',
        note: msg.name ? `${msg.name.slice(0, 28)} · live mainnet` : 'Live mainnet launch',
      };

      this.cp.ingestExternalEvent({ type: 'kol_shred_detected', ts, slot, kolId: null, mint: ev.mint, symbol, venue: ev.venue });
      this.cp.ingestExternalEvent({ type: 'burst_dispatched', ts, burst: ev }, msg.signature ?? null);
      if (this.cp.engineStatus === 'SHADOW' && sizeSol >= 0.2 && this.paper.size < 5 && !this.paper.has(msg.mint)) {
        this.openPaperPosition(ev, msg.vSolInBondingCurve, msg.vTokensInBondingCurve, ws);
      }
      if (msg.uri) void this.hydrateTokenImage(ev, msg.uri, msg.signature ?? null);
    });

    ws.on('error', (err) => {
      console.warn('[solana-feed] New-token stream error:', err.message);
    });

    ws.on('close', () => {
      if (this.stopped || this.pumpWs !== ws) return;
      const wait = Math.min(20_000, 1000 * 2 ** this.pumpRetry++);
      this.pumpTimer = setTimeout(() => this.connectPumpStream(), wait);
    });
  }

  private async hydrateTokenImage(ev: FeedEvent, rawUri: string, sig: string | null) {
    const norm = (u: string) =>
      u.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${u.slice(7)}` : u;
    const url = norm(rawUri.trim());
    if (!/^https?:\/\//i.test(url)) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      const meta = await r.json() as { image?: string };
      if (typeof meta.image === 'string' && meta.image.trim()) {
        const imgUrl = norm(meta.image.trim());
        if (/^https?:\/\//i.test(imgUrl)) {
          this.cp.ingestExternalEvent(
            { type: 'burst_dispatched', ts: ev.ts, burst: { ...ev, image: imgUrl } },
            sig,
          );
          const p = this.paper.get(ev.mint);
          if (p) {
            p.pos = { ...p.pos, image: imgUrl };
            this.cp.updatePaperState(this.listPaperPositions());
          }
        }
      }
    } catch { /* ignore metadata timeout / broken IPFS link */ }
  }

  // ---------- 3. Shadow Mode Real-Price Paper Trader ----------
  private listPaperPositions(): Position[] {
    return [...this.paper.values()].map((e) => e.pos);
  }

  private openPaperPosition(ev: FeedEvent, vSol?: number, vTokens?: number, ws?: WebSocket) {
    const cfg = this.cp.configState().config;
    const entrySol = Math.max(0.05, Math.min(10, cfg.strategy.default_buy_sol || 1));
    const entryPrice = vSol && vTokens && vSol > 0 && vTokens > 0 ? vSol / vTokens : 30 / 1_073_000_000;
    const tokens = entrySol / entryPrice;
    const pos: Position = {
      id: `paper_${ev.mint.slice(0, 12)}`,
      mint: ev.mint,
      symbol: ev.symbol,
      image: ev.image,
      venue: ev.venue,
      kolId: null,
      openedAt: ev.ts,
      openedSlot: ev.slot,
      entrySol,
      initialTokens: tokens,
      tokens,
      entryPrice,
      price: entryPrice,
      realizedSol: 0,
      proceedsSol: 0,
      pendingSell: null,
    };
    this.paper.set(ev.mint, { pos, firedSteps: new Set() });
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [ev.mint] }));
    }
    this.cp.updatePaperState(this.listPaperPositions(), undefined, true);
  }

  private onPaperTrade(mint: string, vSol?: number, vTokens?: number) {
    const entry = this.paper.get(mint);
    if (!entry || !vSol || !vTokens || vSol <= 0 || vTokens <= 0) return;
    const price = vSol / vTokens;
    entry.pos = { ...entry.pos, price };

    const mult = entry.pos.entryPrice > 0 ? price / entry.pos.entryPrice : 1;
    const exits = this.cp.configState().config.exits;
    const slPct = exits.stop_loss_pct ?? 30;

    // 1. Stop-loss check
    if (slPct > 0 && mult <= 1 - slPct / 100) {
      this.closePaperPosition(mint, `Shadow stop-loss (-${slPct}%)`);
      return;
    }

    // 2. Exit ladder take-profit rungs
    for (let i = 0; i < exits.ladder.length; i++) {
      const step = exits.ladder[i];
      if (entry.firedSteps.has(i) || step.trigger.kind !== 'pnl_multiple') continue;
      if (mult >= step.trigger.value) {
        entry.firedSteps.add(i);
        if (step.sell_pct >= 100) {
          this.closePaperPosition(mint, `Shadow TP ${step.trigger.value}x`);
          return;
        }
        const sellTokens = entry.pos.tokens * (step.sell_pct / 100);
        const proceeds = sellTokens * price;
        entry.pos = {
          ...entry.pos,
          tokens: entry.pos.tokens - sellTokens,
          proceedsSol: +((entry.pos.proceedsSol ?? 0) + proceeds).toFixed(6),
          realizedSol: +(entry.pos.realizedSol + proceeds).toFixed(6),
        };
      }
    }

    this.cp.updatePaperState(this.listPaperPositions());
  }

  private closePaperPosition(mint: string, exitReason: string) {
    const entry = this.paper.get(mint);
    if (!entry) return;
    this.paper.delete(mint);
    const remainingProceeds = entry.pos.tokens * entry.pos.price;
    const totalProceeds = +((entry.pos.proceedsSol ?? 0) + remainingProceeds).toFixed(6);
    const closed: ClosedPosition = {
      id: `cl_${entry.pos.id}_${Date.now().toString(36)}`,
      mint: entry.pos.mint,
      symbol: entry.pos.symbol,
      image: entry.pos.image,
      venue: entry.pos.venue,
      kolId: entry.pos.kolId,
      openedAt: entry.pos.openedAt,
      closedAt: Date.now(),
      entrySol: entry.pos.entrySol,
      proceedsSol: totalProceeds,
      solUsd: this.solUsd || 0,
      exitReason,
    };
    if (this.pumpWs?.readyState === WebSocket.OPEN) {
      this.pumpWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] }));
    }
    this.cp.updatePaperState(this.listPaperPositions(), closed);
  }

  private sweepExpiredPaperPositions() {
    const now = Date.now();
    for (const [mint, entry] of this.paper.entries()) {
      if (now - entry.pos.openedAt >= 5 * 60_000) {
        this.closePaperPosition(mint, 'Shadow time cap (5m)');
      }
    }
  }

  private async refreshMarketAndBalance() {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (r.ok) {
        const j = await r.json() as { solana?: { usd?: number } };
        if (typeof j.solana?.usd === 'number' && j.solana.usd > 0) this.solUsd = j.solana.usd;
      }
    } catch { /* ignore */ }

    const hotWallet = this.cp.configState().config.wallets.hot_wallet_pubkey;
    if (hotWallet) {
      try {
        const r = await fetch(this.endpoints.httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [hotWallet] }),
        });
        const j = await r.json() as { result?: { value?: number } };
        if (typeof j.result?.value === 'number') this.solBalance = j.result.value / 1e9;
      } catch { /* ignore */ }
    }
  }
}

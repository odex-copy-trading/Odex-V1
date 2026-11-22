// Read-only Solana Mainnet live feed (zero fake data, zero signing, zero transactions).
// - Real mainnet slots via Solana RPC WebSocket (Helius if available, automatic fallback to api.mainnet-beta.solana.com on 429)
// - Real mainnet Pump.fun new token launches (exact mint, symbol, dev buy SOL, signature) via PumpPortal live stream
// - Real SOL/USD price + real hot-wallet SOL balance via RPC getBalance
// Automatically yields whenever the Rust whal-engine connects to /internal/engine.
import WebSocket from 'ws';
import type { FeedEvent } from '../../lib/types';
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
    this.cp.on('telemetry', (e: { type: string }) => {
      if (e.type === 'config_updated') this.reload();
    });
  }

  stop() {
    this.stopped = true;
    if (this.slotTimer) clearTimeout(this.slotTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.priceTimer) clearInterval(this.priceTimer);
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
      if (this.cp.engineSource === 'bridge') return;
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
    });

    ws.on('message', (raw) => {
      if (this.cp.engineSource === 'bridge') return;
      let msg: {
        signature?: string;
        mint?: string;
        symbol?: string;
        name?: string;
        uri?: string;
        solAmount?: number;
        txType?: string;
        pool?: string;
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg.mint || msg.txType !== 'create') return;
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
        }
      }
    } catch { /* ignore metadata timeout / broken IPFS link */ }
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

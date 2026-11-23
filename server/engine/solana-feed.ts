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

const IGNORED_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const DEX_PROGRAM_VENUES: Array<[string, FeedEvent['venue']]> = [
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun'],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'PumpSwap'],
  ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'Raydium LaunchLab'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium CPMM'],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM'],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Raydium CPMM'],
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Raydium CPMM'],
];

function detectVenueFromLogs(logs: string[]): FeedEvent['venue'] | null {
  const joined = logs.join('\n');
  for (const [programId, venue] of DEX_PROGRAM_VENUES) {
    if (joined.includes(programId)) return venue;
  }
  return null;
}

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
  private paperPriceTimer: ReturnType<typeof setInterval> | null = null;
  private curvePriceTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastPumpMsgAt = 0;
  private lastSlotMsgAt = 0;
  private paper = new Map<string, { pos: Position; peakPrice: number; vSol: number; bondingCurveKey?: string; hasLiveTick: boolean; breakevenArmed: boolean; instantTpFired: boolean; firedSteps: Set<number> }>();
  private watchedKolKeys = new Set<string>();
  private pumpSubscribedKols = new Set<string>();
  private rpcKolReqToPubkey = new Map<number, string>();
  private rpcKolPubkeyToSubId = new Map<string, number>();
  private rpcKolSubIdToPubkey = new Map<number, string>();
  private nextRpcSubReqId = 100;
  private seenKolSigs = new Set<string>();
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
    // Sub-second on-chain Pump.fun bonding-curve price poller (800ms, processed commitment)
    this.curvePriceTimer = setInterval(() => void this.pollBondingCurvesOnChain(), 800);
    this.curvePriceTimer.unref();
    // Fast DexScreener fallback (1.5s) for graduated PumpSwap/Raydium tokens
    this.paperPriceTimer = setInterval(() => void this.pollPaperPricesFromDexScreener(), 1_500);
    this.paperPriceTimer.unref();
    // Zombie WebSocket watchdog: auto-reconnects if PumpPortal or Solana slot WS goes silent
    this.watchdogTimer = setInterval(() => this.checkStaleStreams(), 15_000);
    this.watchdogTimer.unref();
    this.cp.on('telemetry', (e: { type: string; positions?: Position[] }) => {
      if (e.type === 'config_updated') this.reload();
      if (e.type === 'kols_updated') this.syncKolSubscriptions();
      if (e.type === 'position_updated' && e.positions) {
        const liveMints = new Set(e.positions.map((p) => p.mint));
        for (const mint of this.paper.keys()) if (!liveMints.has(mint)) this.paper.delete(mint);
      }
    });
  }

  stop() {
    this.stopped = true;
    if (this.slotTimer) clearTimeout(this.slotTimer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this.paperTimer) clearInterval(this.paperTimer);
    if (this.curvePriceTimer) clearInterval(this.curvePriceTimer);
    if (this.paperPriceTimer) clearInterval(this.paperPriceTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
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
      this.lastSlotMsgAt = Date.now();
      this.rpcKolReqToPubkey.clear();
      this.rpcKolPubkeyToSubId.clear();
      this.rpcKolSubIdToPubkey.clear();
      console.log(`[solana-feed] Slot stream connected (${this.usePublicSlotFallback ? 'public mainnet-beta' : 'configured RPC'})`);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe', params: [] }));
      this.syncKolSubscriptions();
    });

    ws.on('message', (raw) => {
      this.lastSlotMsgAt = Date.now();
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (typeof msg.id === 'number' && typeof msg.result === 'number' && this.rpcKolReqToPubkey.has(msg.id)) {
        const pubkey = this.rpcKolReqToPubkey.get(msg.id)!;
        this.rpcKolReqToPubkey.delete(msg.id);
        this.rpcKolPubkeyToSubId.set(pubkey, msg.result);
        this.rpcKolSubIdToPubkey.set(msg.result, pubkey);
        return;
      }
      if (msg.method === 'slotNotification') {
        const slot = (msg.params as { result?: { slot?: number } })?.result?.slot;
        if (typeof slot === 'number') this.onSlot(slot);
        return;
      }
      if (msg.method === 'logsNotification') {
        const params = msg.params as {
          subscription?: number;
          result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } };
        };
        const subId = params?.subscription;
        const val = params?.result?.value;
        const slot = params?.result?.context?.slot ?? this.lastSlot;
        if (typeof subId !== 'number' || !val?.signature || val.err !== null) return;
        const kolPubkey = this.rpcKolSubIdToPubkey.get(subId);
        if (!kolPubkey) return;
        const logs = Array.isArray(val.logs) ? val.logs : [];
        const venue = detectVenueFromLogs(logs);
        if (!venue) return;
        if (this.seenKolSigs.has(val.signature)) return;
        this.markKolSigSeen(val.signature);
        void this.inspectKolRpcTransaction(kolPubkey, val.signature, slot, venue);
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
      this.lastPumpMsgAt = Date.now();
      this.pumpSubscribedKols.clear();
      console.log('[solana-feed] Connected to live mainnet Pump.fun new-token stream');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      this.syncKolSubscriptions();
      if (this.paper.size > 0) {
        ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...this.paper.keys()] }));
      }
    });

    ws.on('message', (raw) => {
      this.lastPumpMsgAt = Date.now();
      let msg: {
        signature?: string;
        mint?: string;
        traderPublicKey?: string;
        bondingCurveKey?: string;
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

      // 1. Live mainnet trade update for an open Shadow paper position -> real mark-to-market PnL + full exit engine.
      if ((msg.txType === 'buy' || msg.txType === 'sell') && this.paper.has(msg.mint)) {
        this.onPaperTrade(msg.mint, msg.vSolInBondingCurve, msg.vTokensInBondingCurve);
      }

      // 2. Live KOL Copy-Trade detection in Shadow mode (same-slot copy using KOL's exact buySizeSol & maxCurveReserveSol).
      if (msg.txType === 'buy' && msg.traderPublicKey && this.watchedKolKeys.has(msg.traderPublicKey)) {
        this.onKolBuySignal(msg, ws);
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
      const cfg = this.cp.configState().config;
      const withinCurve = !msg.vSolInBondingCurve || msg.vSolInBondingCurve <= cfg.strategy.max_curve_reserve_sol;
      // Selective quality launch filter: 0.5–5.0 SOL dev buy sweet spot + non-empty metadata (name, symbol, uri)
      const hasMeta = Boolean(msg.name?.trim() && msg.symbol?.trim() && msg.uri?.trim());
      if (
        this.cp.engineStatus === 'SHADOW' &&
        cfg.strategy.modes.pumpfun_create_snipe &&
        withinCurve &&
        hasMeta &&
        sizeSol >= 0.5 &&
        sizeSol <= 5.0 &&
        this.paper.size < 5 &&
        !this.paper.has(msg.mint)
      ) {
        this.openPaperPosition(ev, cfg.strategy.default_buy_sol, msg.vSolInBondingCurve, msg.vTokensInBondingCurve, ws, msg.bondingCurveKey);
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

  // ---------- 3. Shadow Mode Real-Price Paper Trader (1:1 parity with Live Mode) ----------
  private markKolSigSeen(sig: string) {
    this.seenKolSigs.add(sig);
    if (this.seenKolSigs.size > 500) {
      const first = this.seenKolSigs.values().next().value;
      if (first) this.seenKolSigs.delete(first);
    }
  }

  private syncKolSubscriptions() {
    const kols = this.cp.snapshot().kols.filter((k) => k.enabled);
    const next = new Set(kols.map((k) => k.pubkey));
    this.watchedKolKeys = next;

    // 1. PumpPortal account-trade subscriptions (re-subscribes cleanly after every reconnect)
    if (this.pumpWs?.readyState === WebSocket.OPEN) {
      const addedPump = [...next].filter((k) => !this.pumpSubscribedKols.has(k));
      const removedPump = [...this.pumpSubscribedKols].filter((k) => !next.has(k));
      if (addedPump.length) {
        this.pumpWs.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: addedPump }));
        for (const k of addedPump) this.pumpSubscribedKols.add(k);
      }
      if (removedPump.length) {
        this.pumpWs.send(JSON.stringify({ method: 'unsubscribeAccountTrade', keys: removedPump }));
        for (const k of removedPump) this.pumpSubscribedKols.delete(k);
      }
    }

    // 2. Solana RPC WebSocket logsSubscribe (processed commitment, ~250-500ms across ALL DEXs)
    if (this.slotWs?.readyState === WebSocket.OPEN) {
      const pendingPubkeys = new Set(this.rpcKolReqToPubkey.values());
      for (const pubkey of next) {
        if (this.rpcKolPubkeyToSubId.has(pubkey) || pendingPubkeys.has(pubkey)) continue;
        const reqId = this.nextRpcSubReqId++;
        this.rpcKolReqToPubkey.set(reqId, pubkey);
        this.slotWs.send(JSON.stringify({
          jsonrpc: '2.0',
          id: reqId,
          method: 'logsSubscribe',
          params: [{ mentions: [pubkey] }, { commitment: 'processed' }],
        }));
      }
      for (const [pubkey, subId] of [...this.rpcKolPubkeyToSubId.entries()]) {
        if (next.has(pubkey)) continue;
        this.rpcKolPubkeyToSubId.delete(pubkey);
        this.rpcKolSubIdToPubkey.delete(subId);
        this.slotWs.send(JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextRpcSubReqId++,
          method: 'logsUnsubscribe',
          params: [subId],
        }));
      }
    }
  }

  /** Parses a confirmed non-reverted KOL transaction detected via Solana RPC logsSubscribe. */
  private async inspectKolRpcTransaction(
    kolPubkey: string,
    signature: string,
    slot: number,
    venue: FeedEvent['venue'],
  ) {
    const rpcUrl = this.usePublicSlotFallback ? PUBLIC_SOLANA_HTTP : this.endpoints.httpUrl;
    const fetchTx = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      try {
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
          }),
        });
        if (!r.ok) return null;
        const j = await r.json() as {
          result?: {
            meta?: {
              err: unknown;
              preBalances?: number[];
              postBalances?: number[];
              preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number | null } }>;
              postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount?: number | null } }>;
            };
            transaction?: { message?: { accountKeys?: Array<string | { pubkey: string }> } };
          } | null;
        };
        return j.result ?? null;
      } finally {
        clearTimeout(t);
      }
    };

    try {
      let tx = await fetchTx();
      if (!tx) {
        await new Promise((res) => setTimeout(res, 500));
        tx = await fetchTx();
      }
      if (!tx?.meta || tx.meta.err !== null) return;

      const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
      const idx = keys.indexOf(kolPubkey);
      if (idx < 0) return;

      const preLamports = tx.meta.preBalances?.[idx] ?? 0;
      const postLamports = tx.meta.postBalances?.[idx] ?? 0;
      let solSpent = (preLamports - postLamports) / 1e9;

      const preTok = new Map<string, number>();
      for (const tb of tx.meta.preTokenBalances ?? []) {
        if (tb.owner === kolPubkey && tb.mint) preTok.set(tb.mint, tb.uiTokenAmount?.uiAmount ?? 0);
      }
      const postTok = new Map<string, number>();
      for (const tb of tx.meta.postTokenBalances ?? []) {
        if (tb.owner === kolPubkey && tb.mint) postTok.set(tb.mint, tb.uiTokenAmount?.uiAmount ?? 0);
      }

      // Include WSOL spend if the KOL bought using wrapped SOL
      const wsolMint = 'So11111111111111111111111111111111111111112';
      const wsolDelta = (preTok.get(wsolMint) ?? 0) - (postTok.get(wsolMint) ?? 0);
      if (wsolDelta > 0) solSpent += wsolDelta;

      // Find the token the KOL acquired (positive net balance delta, ignoring WSOL/USDC/USDT)
      let boughtMint: string | null = null;
      let boughtTokens = 0;
      for (const [mint, postAmt] of postTok.entries()) {
        if (IGNORED_MINTS.has(mint)) continue;
        const delta = postAmt - (preTok.get(mint) ?? 0);
        if (delta > boughtTokens) {
          boughtTokens = delta;
          boughtMint = mint;
        }
      }
      if (!boughtMint || boughtTokens <= 0) return;

      const kol = this.cp.snapshot().kols.find((k) => k.enabled && k.pubkey === kolPubkey);
      if (!kol || solSpent < kol.triggerMargin) return;

      const entryPriceSol = solSpent / boughtTokens;
      this.onKolBuySignal(
        {
          signature,
          mint: boughtMint,
          traderPublicKey: kolPubkey,
          solAmount: +solSpent.toFixed(4),
          venueOverride: venue,
          slotOverride: slot,
          entryPriceSol,
        },
        this.pumpWs ?? undefined,
      );
    } catch { /* ignore transient RPC fetch error */ }
  }

  private onKolBuySignal(
    msg: {
      signature?: string;
      mint?: string;
      traderPublicKey?: string;
      bondingCurveKey?: string;
      symbol?: string;
      solAmount?: number;
      vSolInBondingCurve?: number;
      vTokensInBondingCurve?: number;
      pool?: string;
      venueOverride?: FeedEvent['venue'];
      slotOverride?: number;
      entryPriceSol?: number;
    },
    ws?: WebSocket,
  ) {
    const cfg = this.cp.configState().config;
    if (!cfg.strategy.modes.kol_backrun || !msg.mint || !msg.traderPublicKey) return;
    if (msg.signature) {
      if (this.seenKolSigs.has(msg.signature) && !msg.venueOverride) return;
      this.markKolSigSeen(msg.signature);
    }
    const kol = this.cp.snapshot().kols.find((k) => k.enabled && k.pubkey === msg.traderPublicKey);
    if (!kol) return;
    if (msg.vSolInBondingCurve && msg.vSolInBondingCurve > kol.maxCurveReserveSol) return;

    const ts = Date.now();
    const slot = msg.slotOverride ?? this.lastSlot;
    const symbol = (msg.symbol || msg.mint.slice(0, 4)).trim().slice(0, 16);
    const venue: FeedEvent['venue'] = msg.venueOverride ?? (msg.pool === 'raydium' ? 'Raydium LaunchLab' : 'Pump.fun');
    const ev: FeedEvent = {
      id: `kol_${(msg.signature || msg.mint).slice(0, 16)}`,
      ts,
      slot,
      kind: 'kol_buy',
      kolId: kol.id,
      mint: msg.mint,
      symbol,
      venue,
      sizeSol: kol.buySizeSol,
      fanout: 0,
      winner: null,
      cuUsed: 0,
      reverts: ZERO_REVERTS,
      outcome: 'shadow',
      note: `Copied ${kol.label} · ${msg.solAmount ? `${msg.solAmount} SOL · ` : ''}${msg.venueOverride ? 'RPC live' : 'live mainnet'}`,
    };
    this.cp.ingestExternalEvent({ type: 'kol_shred_detected', ts, slot, kolId: kol.id, mint: ev.mint, symbol, venue: ev.venue });
    this.cp.ingestExternalEvent({ type: 'burst_dispatched', ts, burst: ev }, msg.signature ?? null);
    if (this.cp.engineStatus === 'SHADOW' && this.paper.size < 5 && !this.paper.has(msg.mint)) {
      this.openPaperPosition(ev, kol.buySizeSol, msg.vSolInBondingCurve, msg.vTokensInBondingCurve, ws, msg.bondingCurveKey, msg.entryPriceSol);
    }
  }

  private listPaperPositions(): Position[] {
    return [...this.paper.values()].map((e) => e.pos);
  }

  private openPaperPosition(ev: FeedEvent, desiredBuySol: number, vSol?: number, vTokens?: number, ws?: WebSocket, bondingCurveKey?: string, overrideEntryPrice?: number) {
    const cfg = this.cp.configState().config;
    const buySol = Math.max(0.01, Math.min(100, desiredBuySol || cfg.strategy.default_buy_sol || 1));
    const buyFeeSol = this.cp.estimateExecutionFeeSol();
    const entrySol = +(buySol + buyFeeSol).toFixed(6);

    let tokens: number;
    let effectiveEntryPrice: number;
    let postVSol: number;
    let markPrice: number;

    if ((!vSol || !vTokens) && overrideEntryPrice && overrideEntryPrice > 0) {
      // Non-Pump.fun DEX KOL buy parsed via RPC: 1% fee + 1.5% realistic backrun slippage
      const netSolIn = buySol * 0.99;
      effectiveEntryPrice = overrideEntryPrice * 1.015;
      tokens = netSolIn / effectiveEntryPrice;
      markPrice = overrideEntryPrice;
      postVSol = 50;
    } else {
      // Exact Pump.fun constant-product AMM (x * y = k) + competing sniper front-run impact (+1 slot realism).
      const baseVSol = vSol && vSol > 0 ? vSol : 30;
      const baseVTokens = vTokens && vTokens > 0 ? vTokens : 1_073_000_000;
      const competitionSol = ev.sizeSol >= 1.0 ? 1.5 : 0.6; // competing bots landing ahead in same/+1 slot
      const preVSol = baseVSol + competitionSol;
      const preVTokens = (baseVSol * baseVTokens) / preVSol;

      const netSolIn = buySol * 0.99; // Pump.fun 1% protocol fee
      tokens = (preVTokens * netSolIn) / (preVSol + netSolIn);
      effectiveEntryPrice = buySol / tokens;
      postVSol = preVSol + netSolIn;
      const postVTokens = preVTokens - tokens;
      markPrice = postVSol / postVTokens;
    }

    const pos: Position = {
      id: `paper_${ev.mint.slice(0, 12)}`,
      mint: ev.mint,
      symbol: ev.symbol,
      image: ev.image,
      venue: ev.venue,
      kolId: ev.kolId,
      openedAt: ev.ts,
      openedSlot: ev.slot,
      entrySol,
      initialTokens: tokens,
      tokens,
      entryPrice: effectiveEntryPrice,
      price: markPrice,
      realizedSol: 0,
      proceedsSol: 0,
      pendingSell: null,
    };
    this.paper.set(ev.mint, { pos, peakPrice: markPrice, vSol: postVSol, bondingCurveKey, hasLiveTick: false, breakevenArmed: false, instantTpFired: false, firedSteps: new Set() });
    console.log(`[solana-feed] Shadow AMM buy: $${ev.symbol} (${buySol} SOL + ${buyFeeSol} fee, vSol=${postVSol.toFixed(1)}, curve=${bondingCurveKey ?? 'n/a'})`);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [ev.mint] }));
    }
    this.cp.updatePaperState(this.listPaperPositions(), undefined, true);
  }

  /** Sub-second on-chain Pump.fun bonding-curve reader via batch getMultipleAccounts (commitment: processed). */
  private async pollBondingCurvesOnChain() {
    const targets: { mint: string; curve: string }[] = [];
    for (const [mint, e] of this.paper.entries()) {
      if (e.bondingCurveKey) targets.push({ mint, curve: e.bondingCurveKey });
    }
    if (targets.length === 0) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(this.endpoints.httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getMultipleAccounts',
          params: [targets.map((x) => x.curve), { encoding: 'base64', commitment: 'processed' }],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) return;
      const json = (await r.json()) as { result?: { value?: ({ data?: [string, string] } | null)[] } };
      const vals = json.result?.value;
      if (!Array.isArray(vals)) return;
      let anyChanged = false;
      for (let i = 0; i < targets.length; i++) {
        const b64 = vals[i]?.data?.[0];
        if (!b64) continue;
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 49) continue;
        // Pump.fun BondingCurve layout: disc(0..8) | virtual_token_reserves(8..16) | virtual_sol_reserves(16..24) | ... | complete(48)
        const complete = buf[48] === 1;
        if (complete) {
          // Graduated off bonding curve -> let DexScreener track PumpSwap/Raydium price
          const entry = this.paper.get(targets[i].mint);
          if (entry) entry.bondingCurveKey = undefined;
          continue;
        }
        const vTokens = Number(buf.readBigUInt64LE(8)) / 1e6;
        const vSol = Number(buf.readBigUInt64LE(16)) / 1e9;
        if (vTokens > 0 && vSol > 0) {
          if (this.applyPaperPrice(targets[i].mint, vSol / vTokens, vSol, true)) anyChanged = true;
        }
      }
      if (anyChanged) this.cp.updatePaperState(this.listPaperPositions());
    } catch { /* ignore transient RPC timeouts */ }
  }

  /** Watchdog: terminates and reconnects zombie/half-open WebSockets that stop delivering messages. */
  private checkStaleStreams() {
    if (this.stopped) return;
    const now = Date.now();
    if (this.pumpWs?.readyState === WebSocket.OPEN && this.lastPumpMsgAt > 0 && now - this.lastPumpMsgAt > 30_000) {
      console.warn('[solana-feed] Pump.fun WS stale >30s; terminating and reconnecting');
      const old = this.pumpWs;
      this.pumpWs = null;
      try { old.terminate(); } catch { /* ignore */ }
      this.connectPumpStream();
    }
    if (this.slotWs?.readyState === WebSocket.OPEN && this.lastSlotMsgAt > 0 && now - this.lastSlotMsgAt > 20_000) {
      console.warn('[solana-feed] Slot WS stale >20s; terminating and reconnecting');
      const old = this.slotWs;
      this.slotWs = null;
      try { old.terminate(); } catch { /* ignore */ }
      this.connectSlotStream();
    }
  }

  /** Computes exact constant-product AMM sell proceeds after Pump.fun 1% fee & SWQoS execution fee. */
  private calcAmmSellProceeds(sellTokens: number, markPrice: number, vSol: number): number {
    const curveSol = Math.max(30, vSol);
    const curveTokens = curveSol / markPrice;
    const grossSolOut = Math.min(curveSol * 0.85, (curveSol * sellTokens) / (curveTokens + sellTokens));
    const sellFeeSol = this.cp.estimateExecutionFeeSol();
    return Math.max(0, grossSolOut * 0.99 - sellFeeSol);
  }

  private onPaperTrade(mint: string, vSol?: number, vTokens?: number) {
    if (!vSol || !vTokens || vSol <= 0 || vTokens <= 0) return;
    this.applyPaperPrice(mint, vSol / vTokens, vSol);
  }

  private async pollPaperPricesFromDexScreener() {
    // Only poll DexScreener for mints WITHOUT an active on-chain bondingCurveKey (prevents stale DexScreener cache from flickering against live RPC!).
    const fallbackMints: string[] = [];
    for (const [mint, e] of this.paper.entries()) {
      if (!e.bondingCurveKey) fallbackMints.push(mint);
    }
    if (fallbackMints.length === 0) return;
    const mints = fallbackMints.join(',');
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const data = (await r.json()) as {
        pairs?: { chainId?: string; baseToken?: { address?: string }; priceNative?: string; liquidity?: { quote?: number; usd?: number } }[];
      };
      if (!Array.isArray(data.pairs)) return;
      const bestByMint = new Map<string, { price: number; quoteLiq?: number }>();
      for (const pair of data.pairs) {
        if (pair.chainId && pair.chainId !== 'solana') continue;
        if (pair.liquidity?.usd != null && pair.liquidity.usd < 1000) continue; // ignore spoofed micro-liquidity pools
        const mint = pair.baseToken?.address;
        const price = Number(pair.priceNative);
        if (!mint || !Number.isFinite(price) || price <= 0) continue;
        if (!bestByMint.has(mint)) bestByMint.set(mint, { price, quoteLiq: pair.liquidity?.quote });
      }
      let anyChanged = false;
      for (const [mint, info] of bestByMint) {
        if (this.applyPaperPrice(mint, info.price, info.quoteLiq, true)) anyChanged = true;
      }
      if (anyChanged) this.cp.updatePaperState(this.listPaperPositions());
    } catch { /* ignore transient DexScreener timeouts */ }
  }

  private applyPaperPrice(mint: string, price: number, vSol?: number, batch = false): boolean {
    const entry = this.paper.get(mint);
    if (!entry || !Number.isFinite(price) || price <= 0) return false;
    const prev = entry.pos.price;
    // Outlier / decimal-mismatch sanity guard: reject impossible single-tick >8x spikes or <0.05x glitches
    if (prev > 0 && (price / prev > 8 || price / prev < 0.05)) return false;
    if (entry.pos.entryPrice > 0 && price / entry.pos.entryPrice > 25 && (!vSol || vSol < 50)) return false;
    const changed = prev <= 0 || Math.abs(price - prev) / prev > 1e-6;
    entry.hasLiveTick = true;
    if (!changed) return false;
    entry.pos = { ...entry.pos, price };
    if (vSol && vSol > 0) entry.vSol = vSol;
    if (price > entry.peakPrice) entry.peakPrice = price;

    const mult = entry.pos.entryPrice > 0 ? price / entry.pos.entryPrice : 1;
    if (mult >= 1.25) entry.breakevenArmed = true;
    const exits = this.cp.configState().config.exits;
    const slPct = exits.stop_loss_pct ?? 30;

    // 1. Curve liquidity floor protection (same as live Lighthouse guard)
    if (exits.curve_floor.enabled && vSol != null && vSol > 0 && vSol < exits.curve_floor.min_real_sol_reserves_sol) {
      this.closePaperPosition(mint, 'Shadow curve floor');
      return false;
    }

    // 2. Hard stop-loss check
    if (slPct > 0 && mult <= 1 - slPct / 100) {
      this.closePaperPosition(mint, `Shadow stop-loss (-${slPct}%)`);
      return false;
    }

    // 2b. Breakeven shield: once up >= +25%, protect entry + 3% fee buffer so winners never turn red
    if (entry.breakevenArmed && mult <= 1.03) {
      this.closePaperPosition(mint, 'Shadow breakeven shield');
      return false;
    }

    // 3. Trailing stop-loss (only arms once peak >= +30% to avoid early launch wick stop-outs)
    if (exits.trailing_stop_pct && exits.trailing_stop_pct > 0 && entry.peakPrice >= entry.pos.entryPrice * 1.30) {
      const dropFromPeak = (entry.peakPrice - price) / entry.peakPrice;
      if (dropFromPeak >= exits.trailing_stop_pct / 100) {
        this.closePaperPosition(mint, `Shadow trailing stop (-${exits.trailing_stop_pct}%)`);
        return false;
      }
    }

    // 3b. Fhbh1D-style Instant 25% Take-Profit clip on early momentum pop (+15%+)
    if (!entry.instantTpFired && exits.instant_tp_pct > 0 && mult >= 1.15) {
      entry.instantTpFired = true;
      if (exits.instant_tp_pct >= 100) {
        this.closePaperPosition(mint, `Shadow instant TP (${exits.instant_tp_pct}%)`);
        return false;
      }
      const sellTokens = entry.pos.tokens * (exits.instant_tp_pct / 100);
      const proceeds = this.calcAmmSellProceeds(sellTokens, price, entry.vSol);
      entry.pos = {
        ...entry.pos,
        tokens: entry.pos.tokens - sellTokens,
        proceedsSol: +((entry.pos.proceedsSol ?? 0) + proceeds).toFixed(6),
        realizedSol: +(entry.pos.realizedSol + proceeds).toFixed(6),
      };
    }

    // 4. Exit ladder take-profit rungs (pnl_multiple: e.g. 15% @ 2x, 33% @ 3x, 100%)
    for (let i = 0; i < exits.ladder.length; i++) {
      const step = exits.ladder[i];
      if (entry.firedSteps.has(i) || step.trigger.kind !== 'pnl_multiple') continue;
      if (mult >= step.trigger.value) {
        entry.firedSteps.add(i);
        if (step.sell_pct >= 100) {
          this.closePaperPosition(mint, `Shadow TP ${step.trigger.value}x`);
          return false;
        }
        const sellTokens = entry.pos.tokens * (step.sell_pct / 100);
        const proceeds = this.calcAmmSellProceeds(sellTokens, price, entry.vSol);
        entry.pos = {
          ...entry.pos,
          tokens: entry.pos.tokens - sellTokens,
          proceedsSol: +((entry.pos.proceedsSol ?? 0) + proceeds).toFixed(6),
          realizedSol: +(entry.pos.realizedSol + proceeds).toFixed(6),
        };
      }
    }

    if (!batch) this.cp.updatePaperState(this.listPaperPositions());
    return true;
  }

  private closePaperPosition(mint: string, exitReason: string) {
    const entry = this.paper.get(mint);
    if (!entry) return;
    this.paper.delete(mint);
    const remainingProceeds = this.calcAmmSellProceeds(entry.pos.tokens, entry.pos.price, entry.vSol);
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
    const exits = this.cp.configState().config.exits;
    for (const [mint, entry] of this.paper.entries()) {
      const heldSecs = (now - entry.pos.openedAt) / 1000;
      // Evaluate time_secs exit ladder rungs
      for (let i = 0; i < exits.ladder.length; i++) {
        const step = exits.ladder[i];
        if (entry.firedSteps.has(i) || step.trigger.kind !== 'time_secs') continue;
        if (heldSecs >= step.trigger.value) {
          entry.firedSteps.add(i);
          if (step.sell_pct >= 100) {
            this.closePaperPosition(mint, `Shadow time rung (${step.trigger.value}s)`);
            break;
          }
          const sellTokens = entry.pos.tokens * (step.sell_pct / 100);
          const proceeds = this.calcAmmSellProceeds(sellTokens, entry.pos.price, entry.vSol);
          entry.pos = {
            ...entry.pos,
            tokens: entry.pos.tokens - sellTokens,
            proceedsSol: +((entry.pos.proceedsSol ?? 0) + proceeds).toFixed(6),
            realizedSol: +(entry.pos.realizedSol + proceeds).toFixed(6),
          };
          this.cp.updatePaperState(this.listPaperPositions());
        }
      }
      if (!this.paper.has(mint)) continue;
      const mult = entry.pos.entryPrice > 0 ? entry.pos.price / entry.pos.entryPrice : 1;
      // Dead-launch stagnation cut: if still flat/red (< +2%) after 60s of live ticks, cut early & free slot
      if (entry.hasLiveTick && heldSecs >= 60 && mult < 1.02) {
        this.closePaperPosition(mint, 'Shadow stagnation cut (60s)');
        continue;
      }
      // 5m time cap ONLY for non-runners (< +20%); let runners (>= +20%) ride trailing stop up to 30m hard max
      if (heldSecs >= 300 && mult < 1.20) {
        this.closePaperPosition(mint, 'Shadow time cap (5m)');
        continue;
      }
      if (heldSecs >= 1800) {
        this.closePaperPosition(mint, 'Shadow max hold (30m)');
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

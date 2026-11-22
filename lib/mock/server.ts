// MOCK ONLY. An in-browser stand-in for the bot's WebSocket API so every panel
// is interactive before the live API exists. It sends nothing to any network:
// no RPC, no signing, no transactions. All names, addresses and amounts are fictional.
import { randomPubkey } from '@/lib/pubkey';
import { DEFAULT_CONFIG, LANDER_IDS, SECRETS, diffConfig, validateConfig, type BotConfig } from '@/lib/config/schema';
import type {
  ConfigState, NonceHealth,
  Balances, ChainHealth, ClientCommand, EngineStatus, FeedEvent, InventoryItem, Kol, LanderId, LanderStat,
  Position, RentStats, RevertBreakdown, ServerMessage, Sweep, TerminalState, Venue,
} from '@/lib/types';

const RENT_PER_ACCOUNT = 0.00203928;
const BASE_FEE = 0.000006;
const VENUES: Venue[] = ['Pump.fun', 'PumpSwap', 'Raydium LaunchLab', 'Raydium CPMM'];
const WORDS = ['ORCA', 'KRILL', 'TIDE', 'REEF', 'KELP', 'FIN', 'BRINE', 'SQUID', 'PEARL', 'SHOAL', 'NARWHAL', 'GULL', 'SURF', 'DRIFT', 'ABYSS', 'CORAL', 'SPRAY', 'MANTA'];

const LANDERS: { id: LanderId; name: string; weight: number; tip: [number, number] }[] = [
  { id: 'nozomi', name: 'Temporal / Nozomi', weight: 0.22, tip: [0.001, 0.011] },
  { id: 'stellium', name: 'Stellium', weight: 0.16, tip: [0.011, 0.011] },
  { id: 'landx', name: 'LandX', weight: 0.14, tip: [0.011, 0.011] },
  { id: 'bloom', name: 'Bloom / BlockRazor', weight: 0.12, tip: [0.0001, 0.07] },
  { id: 'jito', name: 'Jito', weight: 0.12, tip: [0.0001, 0.01] },
  { id: 'astralane', name: 'Astralane', weight: 0.07, tip: [0.0001, 0.0001] },
  { id: 'glaive', name: 'Glaive', weight: 0.06, tip: [0.0001, 0.0011] },
  { id: 'fastlanes', name: 'Speed / FastLanes', weight: 0.06, tip: [0.0001, 0.0001] },
  { id: 'tpu', name: 'Direct TPU', weight: 0.05, tip: [0.002, 0.012] },
];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const rint = (a: number, b: number) => Math.floor(rnd(a, b + 1));
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;
const mintFor = () => randomPubkey().slice(0, 40) + 'pump';
const zeroReverts = (): RevertBreakdown => ({ duplicate: 0, mutex: 0, kolNotLanded: 0, slippage: 0, expired: 0 });

function seedKols(): Kol[] {
  const rows: [string, Kol['quote'], number, number, number][] = [
    ['Harpoon', 'SOL', 0.02, 6, 85],
    ['Krill Desk', 'SOL', 0.02, 3, 60],
    ['Deepwater', 'SOL', 0.02, 4, 90],
    ['Reef Runner', 'WSOL', 0.02, 2, 45],
    ['Northern Tide', 'USDC', 1.5, 3, 70],
    ['Bonk Basin', 'BONK', 250000, 2, 50],
    ['Lantern', 'SOL', 0.02, 1.5, 40],
  ];
  return rows.map(([label, quote, triggerMargin, buySizeSol, maxCurveReserveSol], i) => {
    const wins = rint(4, 30), losses = rint(6, 40);
    return {
      id: `kol_${i + 1}`, label, pubkey: randomPubkey(), quote, triggerMargin, buySizeSol, maxCurveReserveSol,
      enabled: i !== 6,
      stats: { wins, losses, realizedSol: +(rnd(-4, 9)).toFixed(4), lastSeenSlot: null },
    };
  });
}

function seedConfig(now: number): ConfigState {
  const c: BotConfig = structuredClone(DEFAULT_CONFIG);
  c.network.rpc_primary_url = 'https://rpc-primary.example.net';
  c.network.rpc_backup_urls = ['https://rpc-backup-1.example.net'];
  c.network.geyser_grpc_url = 'https://geyser.example.net:443';
  c.network.shredstream_url = 'grpc://10.0.0.12:9999';
  c.wallets.hot_wallet_pubkey = randomPubkey();
  c.wallets.wsol_vault_ata = randomPubkey();
  c.wallets.nonce_accounts = Array.from({ length: 8 }, () => randomPubkey());
  for (const id of LANDER_IDS) if (id !== 'tpu') c.landers.providers[id].tip_accounts = Array.from({ length: rint(2, 4) }, () => randomPubkey());
  c.strategy.generic_quote_mints = [randomPubkey(), randomPubkey()];
  const secrets: ConfigState['secrets'] = {};
  for (const s of SECRETS) secrets[s.id] = { set: false, updatedAt: null };
  for (const id of ['network.rpc_api_key', 'network.geyser_token', 'wallets.hot_wallet_keypair', 'landers.jito.auth_token', 'landers.nozomi.auth_token', 'landers.stellium.auth_token'])
    secrets[id] = { set: true, updatedAt: now - rint(1, 9) * 86_400_000 };
  const nonces: NonceHealth[] = c.wallets.nonce_accounts.map((pubkey, i) => ({
    pubkey, status: i === 5 ? 'low_balance' : 'ready', balanceSol: i === 5 ? 0.0011 : 0.00204, lastCheckedAt: now,
  }));
  return { version: 1, config: c, secrets, pendingRestart: [], updatedAt: now, nonces };
}

function seedInventory(): InventoryItem[] {
  const x = (symbol: string, name: string, price: number, amount: number): InventoryItem =>
    ({ mint: randomPubkey(), symbol, name, program: 'Token-2022', kind: 'xStock', amount, priceUsd: price });
  return [
    x('AAPLx', 'Apple xStock', 228.4, 3.12), x('NVDAx', 'NVIDIA xStock', 182.9, 5.4), x('TSLAx', 'Tesla xStock', 412.1, 1.08),
    x('AMDx', 'AMD xStock', 161.3, 2.2), x('SPYx', 'S&P 500 xStock', 668.2, 0.61), x('GLDx', 'Gold xStock', 371.4, 0.9),
    { mint: randomPubkey(), symbol: 'BONK', name: 'Bonk', program: 'SPL', kind: 'Meme', amount: 18_400_000, priceUsd: 0.0000171 },
    { mint: randomPubkey(), symbol: 'EURC', name: 'Euro Coin', program: 'SPL', kind: 'Stablecoin', amount: 2_140.5, priceUsd: 1.158 },
    { mint: randomPubkey(), symbol: 'USDT', name: 'Tether USD', program: 'SPL', kind: 'Stablecoin', amount: 1_812.27, priceUsd: 1 },
    { mint: randomPubkey(), symbol: 'WSOL', name: 'Wrapped SOL', program: 'SPL', kind: 'Wrapped', amount: 0, priceUsd: 0 },
  ];
}

type Listener = (msg: ServerMessage) => void;
let shared: MockTerminalServer | null = null;

/** Simulated bot backend. One instance per MockSocket connection. */
export class MockTerminalServer {
  private s: Omit<TerminalState, 'connection' | 'lastMessageAt'>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private tick = 0;
  private scaled = new Set<string>();

  constructor(public emit: Listener) {
    const now = Date.now();
    const slot = 383_000_000 + rint(0, 900_000);
    this.s = {
      source: 'mock',
      engine: { status: 'RUNNING', changedAt: now },
      chain: { slot, shredLatencyMs: 14, nonces: { ready: 8, total: 8 }, ring: { used: 23, size: 64 } },
      balances: { sol: 42.1834, wsol: 186.4021, usdc: 128_940.55, solUsd: 70.12 },
      feed: [],
      positions: [],
      closed: [],
      kols: seedKols(),
      landers: LANDERS.map((l) => ({ id: l.id, name: l.name, enabled: true, sent: 0, wins: 0, slotDeltaSum: 0, tipPaidSol: 0, revertCostSol: 0 })),
      sweeps: [],
      inventory: seedInventory(),
      rent: { accountsClosed: 1_284, reclaimedSol: +(1_284 * RENT_PER_ACCOUNT).toFixed(6), openSeededAccounts: 0, rentPerAccountSol: RENT_PER_ACCOUNT },
      session: { startedAt: now, bursts: 0, fills: 0, txSent: 0, realizedSol: 0 },
      config: seedConfig(now),
    };
    this.s.chain.nonces.total = this.s.config!.config.wallets.nonce_accounts.length;
    // Backfill a little history so panels aren't empty on first paint.
    for (let i = 0; i < 9; i++) {
      this.s.sweeps.unshift({
        id: uid('sw'), ts: now - (9 - i) * 41 * 60_000, slot: slot - (9 - i) * 6_150, wsolIn: 20,
        usdcOut: +(20 * rnd(68.5, 71.5) * 0.9995).toFixed(2), route: 'Jupiter v6 → ZeroFi', status: 'confirmed',
      });
    }
    for (let i = 0; i < 160; i++) this.burst(true);
    // Backfill closed positions from the filled history.
    for (const ev of this.s.feed.filter((e) => e.outcome === 'filled').slice(0, 40)) {
      const mult = Math.exp(gauss() * 0.45 - 0.12);
      const held = rint(15, Math.max(16, Math.min(1_500, Math.floor((Date.now() - ev.ts) / 1000) - 2))) * 1000;
      this.s.closed.push({
        id: uid('cp'), mint: ev.mint, symbol: ev.symbol, venue: ev.venue, kolId: ev.kolId, openedAt: ev.ts, closedAt: Math.min(Date.now() - 1000, ev.ts + held),
        entrySol: ev.sizeSol, proceedsSol: +(ev.sizeSol * mult * 0.99).toFixed(4), solUsd: +rnd(69, 71.5).toFixed(2),
        exitReason: mult < 0.5 ? 'Liquidity floor' : mult > 1.5 ? 'Auto take-profit' : pick(['KOL sold', 'KOL sold', 'Time cap', 'Manual']),
      });
    }
    this.s.closed.sort((a, b) => b.closedAt - a.closedAt);
    this.s.feed = this.s.feed.slice(0, 40);
  }

  get state() { return this.s; }

  start() {
    this.emit({ type: 'snapshot', state: structuredClone(this.s) });
    this.timers.push(setInterval(() => this.onSlot(), 400));
    this.timers.push(setInterval(() => this.onPrices(), 1000));
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // ---------- clock ----------
  private onSlot() {
    const c = this.s.chain;
    c.slot += 1;
    this.tick++;
    const spike = Math.random() < 0.02;
    c.shredLatencyMs = Math.max(3, Math.round(spike ? rnd(80, 160) : 9 + Math.abs(gauss()) * 9));
    if (c.nonces.ready < c.nonces.total) c.nonces.ready++; // nonce advance + refill ≈ 1 per slot
    const recent = this.s.feed.filter((e) => e.kind !== 'sell' && c.slot - e.slot < 150).length;
    c.ring.used = Math.min(c.ring.size, 18 + recent);
    this.s.balances.solUsd = Math.max(20, this.s.balances.solUsd * Math.exp(gauss() * 0.0004));

    const st = this.s.engine.status;
    if (Math.random() < 1 / 6) this.detect(st);
    if (this.tick % 100 === 0 && this.s.balances.wsol > 140) this.sweep();
    this.emit({ type: 'chain', chain: { ...c, nonces: { ...c.nonces }, ring: { ...c.ring } }, balances: { ...this.s.balances } });
  }

  private detect(st: EngineStatus) {
    if (st === 'RUNNING' || st === 'SHADOW') return this.burst(false);
    const kol = Math.random() < 0.7 ? pick(this.s.kols.filter((k) => k.enabled)) : null;
    const ev: FeedEvent = {
      id: uid('ev'), ts: Date.now(), slot: this.s.chain.slot, kind: kol ? 'kol_buy' : 'launch', kolId: kol?.id ?? null,
      mint: mintFor(), symbol: pick(WORDS), venue: pick(VENUES), sizeSol: kol?.buySizeSol ?? 1.5, fanout: 0, winner: null,
      cuUsed: 0, reverts: zeroReverts(), outcome: 'missed', note: st === 'KILLED' ? 'Kill switch engaged: not sent' : 'Engine paused: not sent',
    };
    this.pushFeed(ev);
  }

  private burst(backfill: boolean) {
    const enabledKols = this.s.kols.filter((k) => k.enabled);
    const kol = enabledKols.length && Math.random() < 0.72 ? pick(enabledKols) : null;
    const shadow = !backfill && this.s.engine.status === 'SHADOW';
    const fanout = rint(kol ? 24 : 12, kol ? 115 : 60);
    const roll = Math.random();
    const outcome: FeedEvent['outcome'] = shadow ? 'shadow' : roll < 0.52 ? 'filled' : roll < 0.9 ? 'missed' : 'expired';
    const r = zeroReverts();
    let rest = outcome === 'filled' || outcome === 'shadow' ? fanout - 1 : fanout;
    if (outcome === 'filled' || outcome === 'shadow') {
      r.expired = Math.min(rest, rint(0, 4)); rest -= r.expired;
      r.mutex = Math.min(rest, rint(0, Math.ceil(fanout * 0.08))); rest -= r.mutex;
      r.slippage = Math.min(rest, rint(0, 3)); rest -= r.slippage;
      r.duplicate = rest;
    } else if (outcome === 'missed') {
      r.kolNotLanded = kol ? Math.ceil(rest * rnd(0.5, 0.9)) : 0; rest -= r.kolNotLanded;
      r.slippage = Math.ceil(rest * rnd(0.3, 0.8)); rest -= r.slippage;
      r.duplicate = rest;
    } else {
      r.expired = Math.ceil(rest * rnd(0.6, 1)); rest -= r.expired; r.duplicate = rest;
    }
    const cuUsed = (outcome === 'filled' || outcome === 'shadow' ? rint(46_000, 51_000) : 0)
      + r.duplicate * 2_523 + r.mutex * 450 + r.kolNotLanded * 601 + r.slippage * rint(28_000, 41_000) + r.expired * 2_383;

    // Distribute sends across enabled landers; pick a weighted winner.
    const live = LANDERS.filter((l) => this.s.landers.find((x) => x.id === l.id)?.enabled);
    const totalW = live.reduce((a, l) => a + l.weight, 0);
    let winner: LanderId | null = null;
    if ((outcome === 'filled' || outcome === 'shadow') && live.length) {
      let x = Math.random() * totalW;
      for (const l of live) { x -= l.weight; if (x <= 0) { winner = l.id; break; } }
      winner ??= live[0].id;
    }
    const symbol = pick(WORDS);
    const ageSec = backfill ? rint(5, 3_600) : 0;
    const ev: FeedEvent = {
      id: uid('ev'), ts: Date.now() - ageSec * 1000, slot: this.s.chain.slot - Math.round(ageSec * 2.5),
      kind: kol ? 'kol_buy' : 'launch', kolId: kol?.id ?? null, mint: mintFor(), symbol, venue: pick(VENUES),
      sizeSol: kol?.buySizeSol ?? 1.5, fanout, winner, cuUsed, reverts: r, outcome,
      note: shadow ? 'Shadow mode: simulated, nothing sent' : undefined,
    };

    if (!shadow) {
      for (const l of live) {
        const stat = this.s.landers.find((x) => x.id === l.id)!;
        const sent = Math.max(1, Math.round((fanout * l.weight) / totalW));
        stat.sent += sent;
        if (winner === l.id) {
          stat.wins += 1; stat.slotDeltaSum += pick([0, 0, 0, 0, 1, 1, 2]);
          const tip = +rnd(l.tip[0], l.tip[1]).toFixed(4);
          stat.tipPaidSol += tip;
          if (!backfill) this.s.balances.sol -= tip;
          stat.revertCostSol += (sent - 1) * BASE_FEE;
        } else stat.revertCostSol += sent * BASE_FEE;
      }
      this.s.session.bursts++;
      this.s.session.txSent += fanout;
      if (!backfill) this.s.balances.sol -= fanout * BASE_FEE;
      if (kol) kol.stats.lastSeenSlot = ev.slot;
      if (outcome === 'filled') {
        this.s.session.fills++;
        if (!backfill) this.openPosition(ev);
      }
      if (!backfill) {
        this.s.chain.nonces.ready = Math.max(0, this.s.chain.nonces.ready - rint(1, 3));
        this.emit({ type: 'landers', landers: structuredClone(this.s.landers) });
        this.emit({ type: 'session', session: { ...this.s.session } });
        this.emit({ type: 'kols', kols: structuredClone(this.s.kols) });
      }
    }
    if (backfill) this.s.feed.push(ev);
    else this.pushFeed(ev);
    if (backfill) this.s.feed.sort((a, b) => b.ts - a.ts);
  }

  private pushFeed(ev: FeedEvent) {
    this.s.feed.unshift(ev);
    if (this.s.feed.length > 300) this.s.feed.length = 300;
    this.emit({ type: 'feed', event: ev });
  }

  private openPosition(ev: FeedEvent) {
    const price = rnd(2e-8, 6e-8);
    const tokens = ev.sizeSol / price;
    this.s.balances.wsol -= ev.sizeSol;
    this.s.positions.unshift({
      id: uid('pos'), mint: ev.mint, symbol: ev.symbol, venue: ev.venue, kolId: ev.kolId, openedAt: Date.now(), openedSlot: ev.slot,
      entrySol: ev.sizeSol, initialTokens: tokens, tokens, entryPrice: price, price, realizedSol: 0, pendingSell: null,
    });
    if (this.s.positions.length > 14) {
      // keep the mock tidy: close the oldest at market
      const oldest = this.s.positions[this.s.positions.length - 1];
      this.sell(oldest, 100, 'Time cap', false);
    }
    this.s.rent.openSeededAccounts = this.s.positions.length;
    this.emitPositions();
  }

  private onPrices() {
    for (const p of [...this.s.positions]) {
      p.price *= Math.exp(gauss() * 0.045 - 0.0012);
      const mult = p.price / p.entryPrice;
      if (mult >= 1.6 && !this.scaled.has(p.id)) { this.scaled.add(p.id); this.sell(p, 25, 'Auto take-profit', false); }
      else if (mult <= 0.45) this.sell(p, 100, 'Liquidity floor', false);
      else if (Math.random() < 1 / 150) this.sell(p, 100, 'KOL sold', false);
    }
    this.emitPositions();
  }

  private sell(p: Position, pct: number, note: string, manual: boolean) {
    const qty = pct >= 100 ? p.tokens : p.tokens * (pct / 100);
    const proceeds = qty * p.price * 0.99;
    const costShare = p.entrySol * (qty / p.initialTokens);
    p.tokens -= qty;
    p.realizedSol += proceeds - costShare;
    p.pendingSell = null;
    this.s.balances.wsol += proceeds;
    this.s.session.realizedSol += proceeds - costShare;
    const ev: FeedEvent = {
      id: uid('ev'), ts: Date.now(), slot: this.s.chain.slot, kind: 'sell', kolId: p.kolId, mint: p.mint, symbol: p.symbol, venue: p.venue,
      sizeSol: +proceeds.toFixed(4), fanout: manual ? rint(3, 8) : rint(1, 4), winner: pick(LANDERS).id, cuUsed: rint(38_000, 61_000),
      reverts: zeroReverts(), outcome: 'sold', note: `${manual ? 'Manual' : note} · ${pct}%`,
    };
    this.pushFeed(ev);
    p.proceedsSol = (p.proceedsSol ?? 0) + proceeds;
    if (p.tokens <= p.initialTokens * 0.001) {
      this.s.positions = this.s.positions.filter((x) => x !== p);
      this.s.closed.unshift({
        id: p.id, mint: p.mint, symbol: p.symbol, venue: p.venue, kolId: p.kolId, openedAt: p.openedAt, closedAt: Date.now(),
        entrySol: p.entrySol, proceedsSol: p.proceedsSol, solUsd: this.s.balances.solUsd, exitReason: manual ? 'Manual' : note,
      });
      if (this.s.closed.length > 300) this.s.closed.length = 300;
      this.s.rent.accountsClosed++; this.s.rent.reclaimedSol += RENT_PER_ACCOUNT; this.s.rent.openSeededAccounts = this.s.positions.length;
      this.s.balances.sol += RENT_PER_ACCOUNT;
      const kol = this.s.kols.find((k) => k.id === p.kolId);
      if (kol) { kol.stats.realizedSol += p.realizedSol; if (p.realizedSol > 0) kol.stats.wins++; else kol.stats.losses++; }
      this.emit({ type: 'kols', kols: structuredClone(this.s.kols) });
      this.emitTreasury();
    }
    this.emit({ type: 'session', session: { ...this.s.session } });
  }

  private sweep() {
    const out = +(20 * this.s.balances.solUsd * 0.9995).toFixed(2);
    const sw: Sweep = { id: uid('sw'), ts: Date.now(), slot: this.s.chain.slot, wsolIn: 20, usdcOut: out, route: 'Jupiter v6 → ZeroFi', status: 'pending' };
    this.s.sweeps.unshift(sw);
    this.emitTreasury();
    setTimeout(() => {
      sw.status = 'confirmed';
      this.s.balances.wsol -= 20;
      this.s.balances.usdc += out;
      this.emitTreasury();
    }, 1200);
  }

  private syncNonces() {
    const cs = this.s.config!;
    const prev = new Map(cs.nonces.map((n) => [n.pubkey, n]));
    cs.nonces = cs.config.wallets.nonce_accounts.map((pubkey) => prev.get(pubkey) ?? { pubkey, status: 'ready', balanceSol: 0.00204, lastCheckedAt: Date.now() });
    this.s.chain.nonces.total = cs.nonces.length;
    this.s.chain.nonces.ready = Math.min(this.s.chain.nonces.ready, cs.nonces.length);
  }
  private emitConfig() { this.emit({ type: 'config', config: structuredClone(this.s.config!) }); }
  private emitPositions() { this.s.rent.openSeededAccounts = this.s.positions.length; this.emit({ type: 'positions', positions: structuredClone(this.s.positions), closed: structuredClone(this.s.closed.slice(0, 200)) }); }
  private emitTreasury() { this.emit({ type: 'treasury', sweeps: structuredClone(this.s.sweeps.slice(0, 60)), inventory: structuredClone(this.s.inventory), rent: { ...this.s.rent } }); }

  // ---------- commands ----------
  handle(id: string, cmd: ClientCommand) {
    const ack = (ok: boolean, error?: string) => setTimeout(() => this.emit({ type: 'ack', id, ok, error }), rint(80, 220));
    switch (cmd.type) {
      case 'engine.set': {
        this.s.engine = { status: cmd.status, changedAt: Date.now() };
        this.emit({ type: 'engine', ...this.s.engine });
        return ack(true);
      }
      case 'engine.kill': {
        this.s.engine = { status: 'KILLED', changedAt: Date.now(), reason: cmd.reason };
        this.emit({ type: 'engine', ...this.s.engine });
        return ack(true);
      }
      case 'position.sell': {
        const p = this.s.positions.find((x) => x.id === cmd.positionId);
        if (!p) return ack(false, 'Position no longer open');
        if (p.pendingSell) return ack(false, 'A sell is already in flight');
        p.pendingSell = cmd.pct;
        this.emitPositions();
        setTimeout(() => { if (this.s.positions.includes(p)) { this.sell(p, cmd.pct, 'Manual', true); this.emitPositions(); } }, rint(350, 800));
        return ack(true);
      }
      case 'kol.upsert': {
        const i = this.s.kols.findIndex((k) => k.id === cmd.kol.id);
        if (this.s.kols.some((k, j) => k.pubkey === cmd.kol.pubkey && j !== i)) return ack(false, 'That wallet is already on the watchlist');
        const stats = i >= 0 ? this.s.kols[i].stats : { wins: 0, losses: 0, realizedSol: 0, lastSeenSlot: null };
        const next: Kol = { ...cmd.kol, stats };
        if (i >= 0) this.s.kols[i] = next; else this.s.kols.push(next);
        this.emit({ type: 'kols', kols: structuredClone(this.s.kols) });
        return ack(true);
      }
      case 'kol.toggle': {
        const k = this.s.kols.find((x) => x.id === cmd.id);
        if (!k) return ack(false, 'Unknown wallet');
        k.enabled = cmd.enabled;
        this.emit({ type: 'kols', kols: structuredClone(this.s.kols) });
        return ack(true);
      }
      case 'config.update': {
        const cs = this.s.config!;
        if (cmd.baseVersion !== cs.version) return ack(false, `The config changed since you opened it (now v${cs.version}). Reload to get the latest.`);
        const v = validateConfig(cmd.config);
        if (!v.ok) return setTimeout(() => this.emit({ type: 'ack', id, ok: false, error: 'Validation failed on the engine', fields: v.errors }), 150);
        const changes = diffConfig(cs.config, v.config);
        const appliedLive = changes.filter((c) => !c.restart).map((c) => c.path);
        for (const c of changes) if (c.restart && !cs.pendingRestart.includes(c.path)) cs.pendingRestart.push(c.path);
        cs.config = v.config;
        if (changes.length) { cs.version++; cs.updatedAt = Date.now(); }
        // Reflect live-applied changes in the simulated engine.
        for (const l of this.s.landers) l.enabled = cs.config.landers.providers[l.id].enabled;
        this.syncNonces();
        this.emitConfig();
        this.emit({ type: 'landers', landers: structuredClone(this.s.landers) });
        return setTimeout(() => this.emit({ type: 'ack', id, ok: true, result: { version: cs.version, appliedLive, pendingRestart: cs.pendingRestart } }), 200);
      }
      case 'secret.set':
      case 'secret.clear': {
        const meta = SECRETS.find((s) => s.id === cmd.id);
        if (!meta) return ack(false, 'Unknown secret');
        if (!meta.uiSettable) return ack(false, 'This secret can only be set on the engine host');
        if (cmd.type === 'secret.set' && (!cmd.value || cmd.value.length > 16_384)) return ack(false, 'Value is empty or too long');
        // MOCK: the value is discarded. The real engine encrypts it at rest and never returns it.
        this.s.config!.secrets[cmd.id] = cmd.type === 'secret.set' ? { set: true, updatedAt: Date.now() } : { set: false, updatedAt: null };
        this.emitConfig();
        return ack(true);
      }
      case 'nonce.create': {
        const cs = this.s.config!;
        const room = 32 - cs.config.wallets.nonce_accounts.length;
        const n = Math.max(0, Math.min(room, cmd.count));
        if (!n) return ack(false, 'Nonce pool is already at the 32-account limit');
        for (let i = 0; i < n; i++) cs.config.wallets.nonce_accounts.push(randomPubkey());
        cs.version++; cs.updatedAt = Date.now();
        this.syncNonces();
        this.emitConfig();
        return setTimeout(() => this.emit({ type: 'ack', id, ok: true, result: { created: n } }), 600);
      }
      case 'nonce.topup': {
        let n = 0;
        for (const x of this.s.config!.nonces) if (x.status === 'low_balance') { x.status = 'ready'; x.balanceSol = 0.00204; n++; }
        this.emitConfig();
        return setTimeout(() => this.emit({ type: 'ack', id, ok: true, result: { toppedUp: n } }), 500);
      }
      case 'nonce.advance': {
        const n = this.s.config!.nonces.find((x) => x.pubkey === cmd.pubkey);
        if (!n) return ack(false, 'Unknown nonce account');
        n.status = 'ready'; n.lastCheckedAt = Date.now();
        this.emitConfig();
        return ack(true);
      }
      case 'nonce.check': {
        const now = Date.now();
        for (const x of this.s.config!.nonces) { x.lastCheckedAt = now; if (Math.random() < 0.08) { x.status = 'low_balance'; x.balanceSol = 0.0012; } }
        this.emitConfig();
        return setTimeout(() => this.emit({ type: 'ack', id, ok: true, result: { checked: this.s.config!.nonces.length } }), 400);
      }
      case 'kol.remove': {
        this.s.kols = this.s.kols.filter((k) => k.id !== cmd.id);
        this.emit({ type: 'kols', kols: structuredClone(this.s.kols) });
        return ack(true);
      }
    }
  }
}

/**
 * WebSocket-shaped wrapper around MockTerminalServer. Swap for `new WebSocket(url)` in Step 2;
 * the store only uses onopen/onmessage/onclose/send/close.
 */
export class MockSocket {
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  private server: MockTerminalServer | null = null;

  constructor(public url: string) {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
      const emit = (msg: ServerMessage) => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) }); };
      // One simulated backend per browser tab, so a reconnect resumes the same state.
      shared ??= new MockTerminalServer(emit);
      shared.emit = emit;
      this.server = shared;
      this.server.start();
    }, 650);
  }

  send(data: string) {
    if (this.readyState !== 1 || !this.server) throw new Error('Socket not open');
    const { id, cmd } = JSON.parse(data) as { id: string; cmd: ClientCommand };
    this.server.handle(id, cmd);
  }

  close(code = 1000, reason = 'client close') {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.server?.stop();
    this.onclose?.({ code, reason });
  }

  /** Dev aid: simulate a dropped connection to review error / reconnect states. */
  simulateDrop() { this.close(1006, 'simulated drop'); }
}

export type { Balances, ChainHealth, LanderStat, RentStats };

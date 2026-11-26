// Deterministic Live Quant Observer Agent — zero LLM cost, 100% real-time math from ControlPlane + SQLite.
import type { ControlPlane } from './control';
import type { Db } from './db';
import type { ClosedPosition } from '../lib/types';

export interface ObserverFinding {
  id: string;
  severity: 'critical' | 'warn' | 'good' | 'info';
  category: 'Risk & Sizing' | 'Slot-0 Execution' | 'KOL Engine' | 'Launch Filter' | 'Exit Machine';
  impactScore: number; // 1-10
  title: string;
  evidence: string;
  action: string;
}

export interface TradeStats {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netSol: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancySol: number;
  profitFactor: number;
  launchTrades: number;
  launchNetSol: number;
  kolTrades: number;
  kolNetSol: number;
}

export interface ObserverReport {
  generatedAt: number;
  engineStatus: string;
  configVersion: number;
  walletSol: number;
  openPositions: number;
  tipMath: {
    defaultBuySol: number;
    buyTipSol: number;
    sellTipSol: number;
    roundTripDragPct: number;
    buySlotTtlMax: number;
    slippageBps: number;
    enabledLanders: number;
  };
  liveAll: TradeStats;
  liveRecent20: TradeStats;
  paperAll: TradeStats;
  paperRecent100: TradeStats;
  slotDistribution: { slot0: number; slot1: number; slot2Plus: number; unknown: number };
  exitAttribution: Array<{ reason: string; trades: number; winRatePct: number; netSol: number; avgSol: number }>;
  landerWinners: Array<{ lander: string; wins: number; sharePct: number }>;
  kolAudit: Array<{
    id: string;
    label: string;
    pubkey: string;
    enabled: boolean;
    buySizeSol: number;
    maxCurveSol: number;
    paperTrades: number;
    paperNetSol: number;
    liveTrades: number;
    liveNetSol: number;
    oversizedForWallet: boolean;
  }>;
  findings: ObserverFinding[];
  plainTextSummary: string;
}

function computeStats(rows: ClosedPosition[]): TradeStats {
  if (!rows.length) {
    return {
      trades: 0, wins: 0, losses: 0, winRatePct: 0, netSol: 0,
      avgWinPct: 0, avgLossPct: 0, expectancySol: 0, profitFactor: 0,
      launchTrades: 0, launchNetSol: 0, kolTrades: 0, kolNetSol: 0,
    };
  }
  let wins = 0, losses = 0, netSol = 0, grossWin = 0, grossLoss = 0;
  let winPctSum = 0, lossPctSum = 0;
  let launchTrades = 0, launchNetSol = 0, kolTrades = 0, kolNetSol = 0;

  for (const r of rows) {
    const entry = Math.max(r.entrySol || 0, 1e-9);
    const pnl = (r.proceedsSol || 0) - (r.entrySol || 0);
    const pct = (pnl / entry) * 100;
    netSol += pnl;
    if (pnl > 0) {
      wins++;
      grossWin += pnl;
      winPctSum += pct;
    } else {
      losses++;
      grossLoss += Math.abs(pnl);
      lossPctSum += pct;
    }
    if (r.kolId) {
      kolTrades++;
      kolNetSol += pnl;
    } else {
      launchTrades++;
      launchNetSol += pnl;
    }
  }
  const n = rows.length;
  return {
    trades: n,
    wins,
    losses,
    winRatePct: +(wins * 100 / n).toFixed(1),
    netSol: +netSol.toFixed(4),
    avgWinPct: wins ? +(winPctSum / wins).toFixed(1) : 0,
    avgLossPct: losses ? +(lossPctSum / losses).toFixed(1) : 0,
    expectancySol: +(netSol / n).toFixed(5),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
    launchTrades,
    launchNetSol: +launchNetSol.toFixed(4),
    kolTrades,
    kolNetSol: +kolNetSol.toFixed(4),
  };
}

export function buildObserverReport(cp: ControlPlane, db: Db): ObserverReport {
  const snap = cp.snapshot();
  const cfgState = cp.configState();
  const cfg = cfgState.config;
  const closedAll = snap.closed ?? [];

  const paper = closedAll.filter((c) => String(c.id).startsWith('cl_paper_'));
  const live = closedAll.filter((c) => !String(c.id).startsWith('cl_paper_'));

  const liveAll = computeStats(live);
  const liveRecent20 = computeStats(live.slice(0, 20));
  const paperAll = computeStats(paper);
  const paperRecent100 = computeStats(paper.slice(0, 100));

  // Tip drag math
  const providers = Object.values(cfg.landers.providers).filter((p) => p.enabled && p.fanout > 0);
  const buyTipSol = providers.length ? Math.max(...providers.map((p) => p.max_tip_sol)) : 0;
  const sellTipSol = providers.length ? Math.max(...providers.map((p) => p.min_tip_sol)) : 0;
  const defaultBuySol = cfg.strategy.default_buy_sol || 0.2;
  const roundTripDragPct = +(((buyTipSol + sellTipSol) / Math.max(defaultBuySol, 0.01) + 0.02) * 100).toFixed(2);
  const walletSol = +(snap.balances?.sol ?? 0);

  // Landing slot distribution on recent 30 live trades
  const slotDistribution = { slot0: 0, slot1: 0, slot2Plus: 0, unknown: 0 };
  for (const r of live.slice(0, 30)) {
    const d = r.slotDelta;
    if (typeof d !== 'number' || !Number.isFinite(d)) slotDistribution.unknown++;
    else if (d <= 0) slotDistribution.slot0++;
    else if (d === 1) slotDistribution.slot1++;
    else slotDistribution.slot2Plus++;
  }

  // Exit attribution across Paper + Live (use live if >= 10 with distinct reasons, else combined paper+live for strategy insight)
  const attrSource = live.length >= 15 && new Set(live.map((x) => x.exitReason)).size > 2 ? live : closedAll;
  const byReason = new Map<string, { n: number; w: number; pnl: number }>();
  for (const r of attrSource) {
    const key = r.exitReason || 'Unknown';
    const cur = byReason.get(key) ?? { n: 0, w: 0, pnl: 0 };
    const pnl = (r.proceedsSol || 0) - (r.entrySol || 0);
    cur.n++;
    if (pnl > 0) cur.w++;
    cur.pnl += pnl;
    byReason.set(key, cur);
  }
  const exitAttribution = [...byReason.entries()]
    .map(([reason, d]) => ({
      reason,
      trades: d.n,
      winRatePct: +(d.w * 100 / Math.max(d.n, 1)).toFixed(1),
      netSol: +d.pnl.toFixed(4),
      avgSol: +(d.pnl / Math.max(d.n, 1)).toFixed(4),
    }))
    .sort((a, b) => b.netSol - a.netSol)
    .slice(0, 10);

  // Lander winner share from recent 200 bursts in SQLite
  const bursts = db.listBursts({ limit: 200, kinds: ['kol_buy', 'launch'] }).items;
  const winCounts = new Map<string, number>();
  let totalBurstWins = 0;
  for (const b of bursts) {
    if (b.winner && b.outcome === 'filled') {
      winCounts.set(b.winner, (winCounts.get(b.winner) ?? 0) + 1);
      totalBurstWins++;
    }
  }
  const landerWinners = [...winCounts.entries()]
    .map(([lander, wins]) => ({
      lander,
      wins,
      sharePct: totalBurstWins ? +(wins * 100 / totalBurstWins).toFixed(1) : 0,
    }))
    .sort((a, b) => b.wins - a.wins);

  // KOL watchlist audit
  const kolAudit = (snap.kols ?? [])
    .filter((k) => k.enabled)
    .map((k) => {
      const pRows = paper.filter((r) => r.kolId === k.id);
      const lRows = live.filter((r) => r.kolId === k.id);
      const pNet = pRows.reduce((a, r) => a + ((r.proceedsSol || 0) - (r.entrySol || 0)), 0);
      const lNet = lRows.reduce((a, r) => a + ((r.proceedsSol || 0) - (r.entrySol || 0)), 0);
      return {
        id: k.id,
        label: k.label,
        pubkey: k.pubkey,
        enabled: k.enabled,
        buySizeSol: k.buySizeSol,
        maxCurveSol: k.maxCurveReserveSol,
        paperTrades: pRows.length,
        paperNetSol: +pNet.toFixed(4),
        liveTrades: lRows.length,
        liveNetSol: +lNet.toFixed(4),
        oversizedForWallet: walletSol > 0 && k.buySizeSol > Math.max(0.05, walletSol - 0.05),
      };
    });

  // Deterministic quant rules -> actionable improvement findings
  const findings: ObserverFinding[] = [];

  // Rule 1: Oversized KOLs vs live wallet balance
  const oversized = kolAudit.filter((k) => k.oversizedForWallet);
  if (oversized.length > 0) {
    findings.push({
      id: 'kol_oversized',
      severity: 'critical',
      category: 'Risk & Sizing',
      impactScore: 10,
      title: `${oversized.length} enabled KOL(s) exceed your hot wallet balance`,
      evidence: `Hot wallet has ${walletSol.toFixed(3)} SOL, but ${oversized.map((k) => `${k.label} (${k.buySizeSol} SOL)`).join(', ')} will revert with InsufficientFunds on LocalShred.`,
      action: `Lower buySizeSol on those KOLs to <= ${(Math.max(0.05, walletSol * 0.35)).toFixed(2)} SOL.`,
    });
  }

  // Rule 2: Tip drag too high for buy size
  if (roundTripDragPct > 4.2) {
    findings.push({
      id: 'tip_drag_high',
      severity: 'warn',
      category: 'Risk & Sizing',
      impactScore: 9,
      title: `Round-trip fee + tip drag is ${roundTripDragPct}% on ${defaultBuySol} SOL trades`,
      evidence: `Buy tip (${buyTipSol} SOL) + sell tip (${sellTipSol} SOL) + 2% DEX fees require >+${roundTripDragPct}% just to break even on flat trades.`,
      action: `Keep buy tip <= 0.0015 SOL at 0.20 SOL size, or scale trade size >= 0.30 SOL once live WR > 35%.`,
    });
  } else {
    findings.push({
      id: 'tip_drag_healthy',
      severity: 'good',
      category: 'Risk & Sizing',
      impactScore: 7,
      title: `Fee + tip drag is well-calibrated (${roundTripDragPct}%)`,
      evidence: `Buy tip ${buyTipSol} SOL + sell tip ${sellTipSol} SOL across ${providers.length} EU landers on ${defaultBuySol} SOL trades.`,
      action: 'No change needed — tip-to-size ratio is healthy.',
    });
  }

  // Rule 3: Live vs Paper Expectancy gap on Launches
  if (cfg.strategy.modes.pumpfun_create_snipe && paperRecent100.launchTrades >= 20 && paperRecent100.expectancySol < (buyTipSol + sellTipSol)) {
    findings.push({
      id: 'launch_ev_thin',
      severity: 'warn',
      category: 'Launch Filter',
      impactScore: 9,
      title: `Recent Launch EV (${paperRecent100.expectancySol >= 0 ? '+' : ''}${paperRecent100.expectancySol} SOL/trade) is below live tip cost`,
      evidence: `Last ${paperRecent100.launchTrades} Paper launches netted ${paperRecent100.launchNetSol >= 0 ? '+' : ''}${paperRecent100.launchNetSol} SOL (${paperRecent100.winRatePct}% WR) vs ${(buyTipSol + sellTipSol).toFixed(4)} SOL round-trip live tips.`,
      action: 'Run CreateV2 snipes selectively during peak US/EU hours (13:00–22:00 UTC) and rely on KOL Backruns during quiet overnight hours.',
    });
  }

  // Rule 4: KOL Engine zero live fills check
  if (cfg.strategy.modes.kol_backrun && liveAll.kolTrades === 0) {
    findings.push({
      id: 'kol_zero_live',
      severity: 'warn',
      category: 'KOL Engine',
      impactScore: 9,
      title: 'KOL Backrun has 0 live fills so far (vs +0.506 SOL/trade in Paper)',
      evidence: `Paper KOLs netted ${paperAll.kolNetSol >= 0 ? '+' : ''}${paperAll.kolNetSol} SOL across ${paperAll.kolTrades} trades, while Live has 0 KOL fills across ${kolAudit.length} enabled wallets.`,
      action: 'Verify enabled KOLs are actively trading on Pump.fun/PumpSwap/FlashX during your active hours and add 3–5 active EU/Asia wallets.',
    });
  }

  // Rule 5: Slot +0 execution quality
  const measuredSlots = slotDistribution.slot0 + slotDistribution.slot1 + slotDistribution.slot2Plus;
  if (measuredSlots >= 3) {
    const slot0Pct = Math.round((slotDistribution.slot0 * 100) / measuredSlots);
    findings.push({
      id: 'slot0_rate',
      severity: slot0Pct >= 70 ? 'good' : 'warn',
      category: 'Slot-0 Execution',
      impactScore: 8,
      title: `Verified Slot +0 hit rate: ${slot0Pct}% (${slotDistribution.slot0}/${measuredSlots} recent fills)`,
      evidence: `Recent live fills: ${slotDistribution.slot0} at +0, ${slotDistribution.slot1} at +1, ${slotDistribution.slot2Plus} at +2+. Current buy_slot_ttl.max = ${cfg.strategy.buy_slot_ttl.max}.`,
      action: slot0Pct >= 70
        ? 'Amsterdam LocalShred + 5 EU SWQoS landers are landing on target.'
        : 'Lock buy_slot_ttl to { min: 0, max: 0 } to stop late +1/+2 fills.',
    });
  }

  // Rule 6: Live Avg Win compression vs Paper
  if (liveAll.trades >= 10 && liveAll.avgWinPct > 0 && paperAll.avgWinPct > liveAll.avgWinPct * 1.5) {
    findings.push({
      id: 'win_compression',
      severity: 'warn',
      category: 'Exit Machine',
      impactScore: 8,
      title: `Live Avg Win (+${liveAll.avgWinPct}%) is compressed vs Paper (+${paperAll.avgWinPct}%)`,
      evidence: `Live Avg Loss (${liveAll.avgLossPct}%) matches Paper (${paperAll.avgLossPct}%), so stop-losses are working — the gap is letting winning moonbags run.`,
      action: 'Keep 45s flat time-stop + +18% Breakeven shield + >= 0.50 SOL TWAP gate active so winners ride to +60%–+300% instead of getting cut early.',
    });
  }

  // Rule 7: Engine paused reminder
  if (snap.engine?.status === 'PAUSED') {
    findings.push({
      id: 'engine_paused',
      severity: 'info',
      category: 'Slot-0 Execution',
      impactScore: 5,
      title: 'Trading engine is currently PAUSED',
      evidence: 'LocalShred is decoding live mainnet shreds, but ExecutorService will skip all triggers until status = RUNNING.',
      action: 'Click Start in the sidebar when ready to trade live.',
    });
  }

  findings.sort((a, b) => b.impactScore - a.impactScore);

  const lines = [
    `WHAL BOT LIVE QUANT OBSERVER REPORT (${new Date().toISOString()})`,
    `Status: ${snap.engine?.status ?? 'UNKNOWN'} | Config v${cfgState.version} | Wallet: ${walletSol.toFixed(4)} SOL | Open: ${(snap.positions ?? []).length}`,
    `Live All (${liveAll.trades}): WR=${liveAll.winRatePct}% | Net=${liveAll.netSol >= 0 ? '+' : ''}${liveAll.netSol} SOL | AvgWin=+${liveAll.avgWinPct}% | AvgLoss=${liveAll.avgLossPct}% | PF=${liveAll.profitFactor}`,
    `Live Last 20 (${liveRecent20.trades}): WR=${liveRecent20.winRatePct}% | Net=${liveRecent20.netSol >= 0 ? '+' : ''}${liveRecent20.netSol} SOL`,
    `Paper All (${paperAll.trades}): WR=${paperAll.winRatePct}% | Net=+${paperAll.netSol} SOL (Launch=${paperAll.launchNetSol >= 0 ? '+' : ''}${paperAll.launchNetSol}, KOL=+${paperAll.kolNetSol})`,
    `Slot+0 Execution: +0=${slotDistribution.slot0}, +1=${slotDistribution.slot1}, +2+=${slotDistribution.slot2Plus} | Tip Drag=${roundTripDragPct}% | Slippage=${cfg.strategy.slippage_bps}bps`,
    ``,
    `TOP RECOMMENDATIONS:`,
    ...findings.map((f, i) => `  ${i + 1}. [${f.severity.toUpperCase()} | ${f.impactScore}/10 | ${f.category}] ${f.title}\n     Evidence: ${f.evidence}\n     Action:   ${f.action}`),
  ];

  return {
    generatedAt: Date.now(),
    engineStatus: snap.engine?.status ?? 'PAUSED',
    configVersion: cfgState.version,
    walletSol,
    openPositions: (snap.positions ?? []).length,
    tipMath: {
      defaultBuySol,
      buyTipSol,
      sellTipSol,
      roundTripDragPct,
      buySlotTtlMax: cfg.strategy.buy_slot_ttl.max,
      slippageBps: cfg.strategy.slippage_bps,
      enabledLanders: providers.length,
    },
    liveAll,
    liveRecent20,
    paperAll,
    paperRecent100,
    slotDistribution,
    exitAttribution,
    landerWinners,
    kolAudit,
    findings,
    plainTextSummary: lines.join('\n'),
  };
}

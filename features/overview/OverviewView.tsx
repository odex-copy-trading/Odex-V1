'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Snowflake, Upload, X } from '@/components/icons';
import { Skeleton, cx } from '@/components/ui';
import { computePaperEquitySol, usePaperBalance } from '@/lib/paper';
import { useCustomWallets } from '@/lib/custom-wallets';
import { usePhantom } from '@/lib/phantom';
import { kolLabel, portfolioUsd, useCommand, useTerminal } from '@/lib/store';
import { fmtAgo, fmtSol, fmtUsd, tone } from '@/lib/format';
import type { FeedEvent } from '@/lib/types';
import { DateRangePicker, PnlCalendarButton, rangeForPreset, type DateRangeValue } from './DateAndPnlCalendar';
import { ClosedTab, PositionsTab, SignalsTab, TableSkeleton } from './tables';

type Tab = 'positions' | 'closed' | 'signals';

const LADDER_BARS: { pct: string; h: string }[] = [
  { pct: '15%', h: 'h-7' },
  { pct: '25%', h: 'h-10' },
  { pct: '33%', h: 'h-13' },
  { pct: '50%', h: 'h-18' },
  { pct: '100%', h: 'h-26' },
];

function AnimatedUsd({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const currentRef = useRef(value);

  useEffect(() => {
    const from = currentRef.current;
    const to = Number.isFinite(value) ? value : 0;
    if (Math.abs(to - from) < 0.005) {
      currentRef.current = to;
      setDisplay(to);
      return;
    }
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      currentRef.current = to;
      setDisplay(to);
      return;
    }

    const duration = 520;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // Ease-out cubic for crisp Robinhood/Phantom-style counter roll
      const eased = 1 - Math.pow(1 - t, 3);
      const next = from + (to - from) * eased;
      currentRef.current = next;
      setDisplay(next);
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        currentRef.current = to;
        setDisplay(to);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{fmtUsd(display)}</>;
}

function EmptyPositionsLadder() {
  return (
    <div className="flex h-full min-h-[22rem] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-7 flex items-end gap-2.5" aria-hidden>
        {LADDER_BARS.map((b) => (
          <div key={b.pct} className="flex flex-col items-center gap-2">
            <div className={cx('w-11 rounded-md border border-dashed border-line2 bg-card/70 sm:w-14', b.h)} />
            <span className="text-[0.72rem] tabular-nums text-muted">{b.pct}</span>
          </div>
        ))}
      </div>
      <h3 className="text-[1.05rem] font-semibold tracking-tight text-fg">No open positions</h3>
      <p className="mt-1.5 max-w-md text-[0.86rem] leading-relaxed text-muted">
        Filled bursts open a position here, each row armed with the 15 / 25 / 33 / 50 / 100% panic-sell ladder.
      </p>
    </div>
  );
}

export function OverviewView() {
  const { state } = useTerminal();
  const phantom = usePhantom();
  const [paperStartSol] = usePaperBalance();
  const { sumExcluding } = useCustomWallets();
  const { run, busy } = useCommand();
  const [tab, setTab] = useState<Tab>('positions');
  const [kolFilter, setKolFilter] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => rangeForPreset('today'));
  const [unit, setUnit] = useState<'USD' | 'SOL'>('USD');
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const loading = state.connection === 'connecting';
  const px = state.balances.solUsd;

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);

  // Deep-link support: /?tab=positions|closed|signals&kol=<kolId>
  useEffect(() => {
    const readParams = () => {
      const sp = new URLSearchParams(window.location.search);
      const t = sp.get('tab');
      if (t === 'positions' || t === 'closed' || t === 'signals') setTab(t);
      const k = sp.get('kol');
      if (k) {
        setKolFilter(k);
        setDateRange(rangeForPreset('all'));
      }
    };
    readParams();
    window.addEventListener('popstate', readParams);
    return () => window.removeEventListener('popstate', readParams);
  }, []);

  const clearKolFilter = () => {
    setKolFilter(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('kol');
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  };

  const nowMs = Date.now();
  const isShadow = state.engine.status === 'SHADOW';
  const rangeIncludesNow = dateRange.end >= nowMs - 60_000;
  // Strictly separate Paper Mode analytics (paper_* / cl_paper_*) from Real SOL analytics
  const open = useMemo(() => {
    const modePositions = state.positions.filter((p) => (isShadow ? p.id.startsWith('paper_') : !p.id.startsWith('paper_')));
    return rangeIncludesNow ? modePositions : modePositions.filter((p) => p.openedAt >= dateRange.start && p.openedAt <= dateRange.end);
  }, [state.positions, isShadow, dateRange, rangeIncludesNow]);
  const closedP = useMemo(
    () => state.closed.filter((c) => (isShadow ? c.id.startsWith('cl_paper_') : !c.id.startsWith('cl_paper_')) && c.closedAt >= dateRange.start && c.closedAt <= dateRange.end),
    [state.closed, isShadow, dateRange],
  );
  const signalsP = useMemo(
    () => (frozen ?? state.feed).filter((e) => e.kind !== 'launch' && (!!e.kolId || e.kind === 'kol_buy') && e.ts >= dateRange.start && e.ts <= dateRange.end),
    [frozen, state.feed, dateRange],
  );
  const byKol = <T extends { kolId: string | null }>(xs: T[]) => (kolFilter ? xs.filter((x) => x.kolId === kolFilter) : xs);

  // All KPIs synced to the selected dateRange & active mode (Paper vs Real SOL)
  const realizedSol = closedP.reduce((a, c) => a + c.proceedsSol - c.entrySol, 0);
  const realizedUsd = closedP.reduce((a, c) => a + (c.proceedsSol - c.entrySol) * (c.solUsd || px), 0);
  const openValue = open.reduce((a, p) => a + p.tokens * p.price, 0);
  const openCost = open.reduce((a, p) => a + p.entrySol * (p.initialTokens > 0 ? p.tokens / p.initialTokens : 0), 0);
  const unrealSol = open.reduce((a, p) => a + (p.tokens * p.price + (p.proceedsSol ?? 0) - p.entrySol), 0);
  const pnlSol = realizedSol + unrealSol;
  const pnlUsd = realizedUsd + unrealSol * px;
  const paperBalanceAtRangeEndSol = useMemo(() => {
    if (rangeIncludesNow) return computePaperEquitySol(state, paperStartSol);
    const closedUpToEnd = state.closed
      .filter((c) => c.id.startsWith('cl_paper_') && c.closedAt <= dateRange.end)
      .reduce((a, c) => a + (c.proceedsSol - c.entrySol), 0);
    return Math.max(0, paperStartSol + closedUpToEnd);
  }, [state, paperStartSol, dateRange.end, rangeIncludesNow]);
  const hotWallet = state.config?.config.wallets.hot_wallet_pubkey || null;
  const extraCustom = sumExcluding([hotWallet, phantom.publicKey]);
  const phantomExtraSol = phantom.connected && phantom.publicKey && phantom.publicKey !== hotWallet ? (phantom.solBalance ?? 0) : 0;
  const connectedWalletsUsd = (extraCustom.sol + phantomExtraSol) * px + extraCustom.usdc;
  const total = isShadow ? paperBalanceAtRangeEndSol * px : portfolioUsd(state) + connectedWalletsUsd;
  const won = closedP.filter((c) => c.proceedsSol > c.entrySol).length;
  const winRate = closedP.length ? (won / closedP.length) * 100 : null;
  const enabled = state.kols.filter((k) => k.enabled).length;
  const kolFills = closedP.filter((c) => !!c.kolId).length + open.filter((p) => !!p.kolId).length;
  const shadow = state.engine.status === 'SHADOW';
  const killed = state.engine.status === 'KILLED';
  const now = new Date();
  const dateStr = `${now.toLocaleDateString('en-GB', { weekday: 'long' })}, ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;

  const engineOnline = state.engineSource === 'bridge';
  const baseTotal = total - pnlUsd;
  const totalPnlPct = baseTotal > 0 ? (pnlUsd / baseTotal) * 100 : 0;

  const kolBuyCount = (kolId: string) =>
    open.filter((p) => p.kolId === kolId).length + closedP.filter((c) => c.kolId === kolId).length;

  const exportCsv = () => {
    const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [['closed_at', 'symbol', 'mint', 'kol', 'venue', 'entry_sol', 'proceeds_sol', 'pnl_sol', 'exit']];
    for (const c of closedP) rows.push([new Date(c.closedAt).toISOString(), c.symbol, c.mint, state.kols.find((k) => k.id === c.kolId)?.label ?? 'tracked', c.venue, c.entrySol.toFixed(4), c.proceedsSol.toFixed(4), (c.proceedsSol - c.entrySol).toFixed(4), c.exitReason]);
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `odex-closed-positions-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const heroBtn = 'inline-flex h-8 items-center gap-1.5 rounded-[0.55rem] border border-black/25 bg-black/[0.06] px-2.5 text-[0.8rem] font-medium text-[#09090d] transition-colors hover:bg-black/[0.12]';
  const heroDarkBtn = 'inline-flex h-8 items-center gap-1.5 rounded-[0.55rem] bg-[#09090d] px-2.5 text-[0.8rem] font-semibold text-accent transition-colors hover:bg-[#16161f]';
  const actionBtn = 'inline-flex h-8 items-center gap-1.5 rounded-[0.6rem] border px-3 text-[0.82rem] font-medium';

  const tabMeta: Record<Tab, ReactNode> = {
    positions: (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.84rem] tabular-nums text-fg2">
        <span><b className="font-semibold text-fg">{open.length}</b> open</span>
        <span className="text-muted">·</span>
        <span>Value <b className="font-semibold text-fg">{fmtUsd(openValue * px)}</b></span>
        <span className="text-muted">·</span>
        <span>Unrealized <b className={cx('font-semibold', tone(unrealSol))}>{fmtUsd(unrealSol * px, true)}</b> <span className="text-muted">({fmtSol(unrealSol, 2, true)} SOL)</span></span>
      </div>
    ),
    closed: (
      <div className="flex flex-wrap items-center gap-3 text-[0.84rem] tabular-nums text-fg2">
        <span><b className="font-semibold text-fg">{closedP.length}</b> trades · Realized <b className={cx('font-semibold', tone(realizedSol))}>{fmtUsd(realizedUsd, true)}</b></span>
        <button type="button" onClick={exportCsv} disabled={!closedP.length} className={cx(actionBtn, 'border-line bg-card text-fg hover:bg-raised disabled:opacity-45')}>
          <Upload className="size-3.5" aria-hidden />Export
        </button>
      </div>
    ),
    signals: (
      <div className="flex flex-wrap items-center gap-3 text-[0.84rem] tabular-nums text-fg2">
        <span><b className="font-semibold text-fg">{signalsP.length}</b> signals · Filled <b className="font-semibold text-fg">{signalsP.filter((e) => e.outcome === 'filled').length}</b></span>
        <button type="button" aria-pressed={!!frozen} onClick={() => setFrozen(frozen ? null : state.feed)} className={cx(actionBtn, frozen ? 'border-accent/40 bg-accent/15 text-accent' : 'border-line bg-card text-fg hover:bg-raised')}>
          <Snowflake className="size-3.5" aria-hidden />{frozen ? 'Resume' : 'Freeze'}
        </button>
      </div>
    ),
  };

  const filledSegments = winRate == null ? 0 : Math.round((winRate / 100) * 20);
  const statusLabel = state.engine.status === 'RUNNING' ? 'running' : state.engine.status === 'SHADOW' ? 'paper' : state.engine.status === 'KILLED' ? 'killed' : 'paused';
  const statusTone = state.engine.status === 'RUNNING' ? 'text-accent' : state.engine.status === 'KILLED' ? 'text-rose-400' : 'text-amber-400';
  const statusDot = state.engine.status === 'RUNNING' ? 'bg-accent' : state.engine.status === 'KILLED' ? 'bg-rose-400' : 'bg-amber-400';

  const openRows = byKol(open);

  return (
    <div className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col gap-4">
      {/* Top Bento Row: Hero Balance Card + 2x2 KPI Grid */}
      <div className="grid shrink-0 gap-4 lg:grid-cols-2">
        {/* Left Hero Card (Platform Accent Color) */}
        <section aria-label="Total balance" className="flex min-h-[16.5rem] flex-col justify-between rounded-[1.4rem] bg-accent p-6 text-[#09090d] sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.86rem] font-medium text-[#09090d]/85">
              {dateStr} · <Link href="/watchlist" className="font-semibold hover:underline">Watching {enabled} KOL{enabled === 1 ? '' : 's'}</Link>
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                role="switch"
                aria-checked={shadow}
                disabled={busy || killed || loading || !engineOnline}
                title={!engineOnline ? 'Connect the Rust engine to toggle Paper Mode' : undefined}
                onClick={() => run({ type: 'engine.set', status: shadow ? 'RUNNING' : 'SHADOW' }, shadow ? 'Paper Mode off: engine running' : 'Paper Mode on: nothing is sent')}
                className={cx(heroBtn, 'disabled:cursor-not-allowed disabled:opacity-50')}
              >
                Paper
                <span className={cx('relative h-4 w-7 rounded-full transition-colors', shadow ? 'bg-[#09090d]' : 'bg-black/25')}>
                  <span className={cx('absolute top-0.5 size-3 rounded-full bg-accent transition-[left]', shadow ? 'left-3.5' : 'left-0.5')} />
                </span>
              </button>
              <PnlCalendarButton closed={state.closed} positions={state.positions} solUsd={px} defaultPaper={shadow} triggerClassName={heroDarkBtn} />
              <DateRangePicker value={dateRange} onChange={setDateRange} triggerClassName={heroDarkBtn} />
            </div>
          </div>

          <div className="my-5">
            <div className="text-[0.74rem] font-semibold uppercase tracking-[0.12em] text-[#09090d]/70">Total balance</div>
            {loading ? (
              <div className="mt-2 h-14 w-52 animate-pulse rounded-xl bg-black/15" />
            ) : (
              <Link href="/wallets" className="mt-1.5 block truncate text-[3.5rem] font-bold leading-none tracking-tight tabular-nums text-[#09090d] hover:opacity-90 sm:text-[4.25rem]">
                <AnimatedUsd value={total} />
              </Link>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-[0.45rem] bg-[#09090d] px-2.5 py-1 text-[0.78rem] font-semibold tabular-nums text-accent">
              {fmtUsd(pnlUsd, true)} {dateRange.label.toLowerCase()}
            </span>
            <span className="inline-flex items-center rounded-[0.45rem] border border-black/25 px-2.5 py-1 text-[0.78rem] font-semibold tabular-nums text-[#09090d]">
              {totalPnlPct.toFixed(1)}%
            </span>
          </div>
        </section>

        {/* Right 2x2 KPI Grid Card */}
        <section aria-label="Summary metrics" className="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-[1.4rem] border border-line2 bg-panel">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="p-6"><Skeleton className="h-4 w-24" /><Skeleton className="mt-4 h-9 w-32" /><Skeleton className="mt-3 h-3 w-28" /></div>
            ))
          ) : (
            <>
              {/* Period PnL */}
              <div className="flex flex-col justify-between p-5 sm:p-6">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[0.86rem] text-fg2">Period PnL</span>
                  <span role="group" aria-label="Units" className="inline-flex rounded-[0.45rem] border border-line bg-bg p-0.5">
                    {(['USD', 'SOL'] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        aria-pressed={unit === u}
                        onClick={() => setUnit(u)}
                        className={cx('rounded-[0.35rem] px-2 py-0.5 text-[0.7rem] font-semibold transition-colors', unit === u ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}
                      >
                        {u}
                      </button>
                    ))}
                  </span>
                </div>
                <div className={cx('my-2.5 truncate text-[1.95rem] font-bold leading-none tracking-tight tabular-nums', tone(pnlSol))}>
                  {unit === 'USD' ? fmtUsd(pnlUsd, true) : `${fmtSol(pnlSol, 3, true)} SOL`}
                </div>
                <div className="text-[0.8rem] tabular-nums text-muted">
                  Realized {unit === 'USD' ? fmtUsd(realizedUsd, true) : fmtSol(realizedSol, 3, true)} · Open {unit === 'USD' ? fmtUsd(unrealSol * px, true) : fmtSol(unrealSol, 3, true)}
                </div>
              </div>

              {/* Open positions */}
              <div className="flex flex-col justify-between p-5 sm:p-6">
                <div className="text-[0.86rem] text-fg2">Open positions</div>
                <div className="my-2.5 truncate text-[1.95rem] font-bold leading-none tracking-tight tabular-nums text-fg">
                  {fmtUsd(openValue * px)}
                </div>
                <div className="text-[0.8rem] tabular-nums text-muted">
                  {open.length} open · cost {fmtSol(openCost, 2)} SOL
                </div>
              </div>

              {/* Win rate */}
              <div className="flex flex-col justify-between p-5 sm:p-6">
                <div className="text-[0.86rem] text-fg2">Win rate</div>
                <div className="my-2 text-[1.95rem] font-bold leading-none tracking-tight tabular-nums text-fg">
                  {winRate == null ? '—' : `${winRate.toFixed(1)}%`}
                </div>
                <div>
                  <div className="mb-2 grid grid-cols-20 gap-1" aria-hidden>
                    {Array.from({ length: 20 }).map((_, i) => (
                      <span key={i} className={cx('h-1.5 rounded-[2px]', i < filledSegments ? 'bg-accent' : 'bg-line2')} />
                    ))}
                  </div>
                  <div className="text-[0.8rem] tabular-nums text-muted">
                    {won} won · {closedP.length - won} lost · {closedP.length} closed
                  </div>
                </div>
              </div>

              {/* KOLs */}
              <div className="flex flex-col justify-between p-5 sm:p-6">
                <Link href="/watchlist" className="text-[0.86rem] text-fg2 hover:text-fg hover:underline">KOLs</Link>
                <Link href="/watchlist" className="my-2.5 block text-[1.95rem] font-bold leading-none tracking-tight tabular-nums text-fg hover:text-accent">
                  {state.kols.length}
                </Link>
                <div className="text-[0.8rem] tabular-nums text-muted">
                  {enabled} enabled · {kolFills} buys {dateRange.label.toLowerCase()}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Bottom Bento Row: Main Positions/Closed/Signals Panel + Right Live Signals & Watching Stack */}
      <div className="grid flex-1 items-stretch gap-4 lg:grid-cols-[1fr_21.5rem] xl:grid-cols-[1fr_24rem]">
        {/* Left Main Panel */}
        <section role="tabpanel" aria-label={tab} className="flex min-h-[26rem] min-w-0 flex-col overflow-hidden rounded-[1.4rem] border border-line2 bg-panel">
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <div role="tablist" aria-label="Views" className="inline-flex max-w-full gap-1 overflow-x-auto rounded-[0.75rem] bg-bg/80 p-1">
                {([['positions', 'Positions', open.length], ['closed', 'Closed', closedP.length], ['signals', 'Live signals', signalsP.length]] as const).map(([v, l, n]) => (
                  <button
                    key={v}
                    role="tab"
                    type="button"
                    aria-selected={tab === v}
                    onClick={() => setTab(v)}
                    className={cx(
                      'inline-flex items-center gap-2 whitespace-nowrap rounded-[0.55rem] px-3.5 py-1.5 text-[0.86rem] font-medium transition-colors',
                      tab === v ? 'bg-fg text-bg shadow-xs' : 'text-fg2 hover:text-fg',
                    )}
                  >
                    {l}
                    <span className={cx('text-[0.76rem] tabular-nums', tab === v ? 'text-bg/70' : 'text-muted')}>{n}</span>
                  </button>
                ))}
              </div>
              {kolFilter && (
                <span className="inline-flex items-center gap-1.5 rounded-[0.6rem] border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
                  @{kolLabel(state, kolFilter)}
                  <button type="button" onClick={clearKolFilter} aria-label="Clear KOL filter" className="rounded p-0.5 hover:bg-accent/20"><X className="size-3.5" /></button>
                </span>
              )}
            </div>
            {tabMeta[tab]}
          </header>

          <div className="flex flex-1 flex-col overflow-x-auto">
            {loading ? (
              <TableSkeleton rows={6} cols={6} />
            ) : tab === 'positions' ? (
              openRows.length === 0 ? <EmptyPositionsLadder /> : <PositionsTab rows={openRows} unit={unit} />
            ) : tab === 'closed' ? (
              <ClosedTab rows={byKol(closedP).slice(0, 100)} unit={unit} />
            ) : (
              <SignalsTab rows={byKol(signalsP).slice(0, 200)} />
            )}
          </div>
        </section>

        {/* Right Sidebar Stack: Live signals + Watching */}
        <aside className="flex h-full flex-col gap-4">
          {/* Live signals card (live trades from tracked wallets) */}
          <section aria-label="Live signals" className="flex min-h-[16rem] flex-1 flex-col rounded-[1.4rem] border border-line2 bg-panel p-5">
            <div className="mb-3.5 flex shrink-0 items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-[0.95rem] font-semibold tracking-tight text-fg">Live signals</h2>
                <span className="rounded-md bg-raised px-1.5 py-0.5 text-[0.72rem] font-medium tabular-nums text-fg2">
                  {signalsP.length}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {signalsP.length > 0 && (
                  <button
                    type="button"
                    aria-pressed={!!frozen}
                    onClick={() => setFrozen(frozen ? null : state.feed)}
                    className={cx(
                      'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[0.72rem] font-medium transition-colors',
                      frozen ? 'border-accent/40 bg-accent/15 text-accent' : 'border-line bg-card text-fg2 hover:text-fg',
                    )}
                  >
                    <Snowflake className="size-3" aria-hidden />{frozen ? 'Resume' : 'Freeze'}
                  </button>
                )}
                <span className={cx('inline-flex items-center gap-1.5 text-[0.78rem] font-medium', statusTone)}>
                  <span className={cx('size-1.5 rounded-full', statusDot)} aria-hidden />
                  {statusLabel}
                </span>
              </div>
            </div>

            {signalsP.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-line bg-bg/50 px-5 py-10 text-center">
                <p className="text-[0.9rem] font-medium text-fg">No live signals yet</p>
                <p className="mt-1.5 text-[0.8rem] leading-relaxed text-muted">
                  Live trades from your tracked wallets stream here the moment they land. {state.engine.status === 'PAUSED' ? 'Start the engine to listen.' : 'Listening for wallet trades.'}
                </p>
              </div>
            ) : (
              <ol className="flex-1 space-y-2 overflow-y-auto pr-0.5">
                {signalsP.slice(0, 30).map((e) => (
                  <li
                    key={e.id}
                    onClick={() => { setTab('signals'); if (e.kolId) setKolFilter(e.kolId); }}
                    className="flash-in flex cursor-pointer items-center justify-between gap-2.5 rounded-xl border border-line bg-card px-3 py-2.5 text-[0.8rem] transition-colors hover:border-accent/40 hover:bg-raised"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cx(
                          'shrink-0 rounded px-1.5 py-0.5 text-[0.64rem] font-bold uppercase tracking-wide',
                          e.kind === 'sell' ? 'bg-rose-500/15 text-rose-400' : 'bg-emerald-500/15 text-emerald-400',
                        )}>
                          {e.kind === 'sell' ? 'SELL' : 'BUY'}
                        </span>
                        <span className="truncate font-semibold text-fg">${e.symbol}</span>
                        <Link href={e.kolId ? `/watchlist#${encodeURIComponent(e.kolId)}` : '/watchlist'} className="truncate text-[0.76rem] font-medium text-accent hover:underline">
                          @{kolLabel(state, e.kolId)}
                        </Link>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[0.72rem] tabular-nums text-muted">
                        <span>{e.sizeSol > 0 ? `${fmtSol(e.sizeSol, 2)} SOL` : '—'}</span>
                        <span>·</span>
                        <span className="truncate">{e.venue}</span>
                      </div>
                    </div>
                    <span className="shrink-0 whitespace-nowrap rounded bg-raised px-2 py-0.5 text-[0.7rem] font-medium tabular-nums text-fg2">
                      {fmtAgo(e.ts, nowTick)} ago
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Watching KOLs card */}
          <section aria-label="Watching KOLs" className="shrink-0 rounded-[1.4rem] border border-line2 bg-panel p-5">
            <div className="mb-3.5 flex items-center justify-between gap-2">
              <h2 className="text-[0.95rem] font-semibold tracking-tight text-fg">Watching</h2>
              <Link href="/watchlist" className="text-[0.8rem] font-medium text-accent hover:underline">
                Manage KOLs →
              </Link>
            </div>

            <div className="space-y-2">
              {state.kols.slice(0, 5).map((k, idx) => (
                <Link
                  key={k.id}
                  href={`/watchlist#${encodeURIComponent(k.id)}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-card px-3.5 py-3 transition-colors hover:border-line2 hover:bg-raised"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised text-[0.76rem] font-semibold text-fg2">
                      K{idx + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[0.88rem] font-semibold text-fg">{k.label}</div>
                      <div className="text-[0.74rem] tabular-nums text-muted">
                        {kolBuyCount(k.id)} buys {dateRange.label.toLowerCase()}
                      </div>
                    </div>
                  </div>
                  <span className={cx(
                    'shrink-0 rounded-[0.35rem] px-2 py-0.5 text-[0.66rem] font-bold uppercase tracking-wide',
                    k.enabled ? 'bg-accent text-[#09090d]' : 'bg-raised text-muted',
                  )}>
                    {k.enabled ? 'Enabled' : 'Paused'}
                  </span>
                </Link>
              ))}
            </div>

            <Link
              href="/watchlist#add="
              className="mt-3 flex h-11 w-full items-center justify-center rounded-xl border border-dashed border-line2 text-[0.84rem] font-medium text-fg2 transition-colors hover:border-accent/60 hover:text-fg"
            >
              + Add KOL
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}

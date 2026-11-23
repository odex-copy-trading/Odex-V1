'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Snowflake, Upload, Zap } from '@/components/icons';
import { Badge, Skeleton, cx } from '@/components/ui';
import { computePaperEquitySol, usePaperBalance } from '@/lib/paper';
import { portfolioUsd, useCommand, useTerminal } from '@/lib/store';
import { fmtSol, fmtUsd, tone } from '@/lib/format';
import type { FeedEvent } from '@/lib/types';
import { DateRangePicker, PnlCalendarButton, rangeForPreset, type DateRangeValue } from './DateAndPnlCalendar';
import { PctChip } from './shared';
import { ClosedTab, PositionsTab, SignalsTab, TableSkeleton } from './tables';

type Tab = 'positions' | 'closed' | 'signals';
type Source = 'all' | 'kol' | 'launch';

const Sep = () => <span aria-hidden className="h-4 w-px bg-line2" />;

function Kpi({ label, extra, children, sub, first }: { label: string; extra?: ReactNode; children: ReactNode; sub: ReactNode; first?: boolean }) {
  return (
    <div className={cx('min-w-0 px-6 pb-6 pt-5', first && 'sm:pl-7')}>
      <div className="flex h-6 items-center justify-between gap-2 whitespace-nowrap text-[0.9rem] text-fg2">{label}{extra}</div>
      <div className={cx('truncate font-bold tracking-tight tabular-nums', first ? 'mb-1.5 mt-2.5 text-[2.9rem] leading-none' : 'mb-2 mt-3.5 text-[1.85rem] leading-none')}>{children}</div>
      <div className="flex flex-wrap items-center gap-2 text-[0.85rem] text-muted">{sub}</div>
    </div>
  );
}

export function OverviewView() {
  const { state } = useTerminal();
  const [paperStartSol] = usePaperBalance();
  const { run, busy } = useCommand();
  const [tab, setTab] = useState<Tab>('positions');
  const [source, setSource] = useState<Source>('all');
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => rangeForPreset('today'));
  const [unit, setUnit] = useState<'USD' | 'SOL'>('USD');
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const loading = state.connection === 'connecting';
  const px = state.balances.solUsd;

  const open = state.positions;
  const closedP = useMemo(
    () => state.closed.filter((c) => c.closedAt >= dateRange.start && c.closedAt <= dateRange.end),
    [state.closed, dateRange],
  );
  const signalsP = useMemo(
    () => (frozen ?? state.feed).filter((e) => e.ts >= dateRange.start && e.ts <= dateRange.end),
    [frozen, state.feed, dateRange],
  );
  const bySource = <T extends { kolId: string | null }>(xs: T[], s: Source) => (s === 'all' ? xs : xs.filter((x) => (s === 'kol' ? !!x.kolId : !x.kolId)));

  // KPIs, scoped to the selected period like the reference design
  const realizedSol = closedP.reduce((a, c) => a + c.proceedsSol - c.entrySol, 0);
  const realizedUsd = closedP.reduce((a, c) => a + (c.proceedsSol - c.entrySol) * c.solUsd, 0);
  const openValue = open.reduce((a, p) => a + p.tokens * p.price, 0);
  const openCost = open.reduce((a, p) => a + p.entrySol * (p.tokens / p.initialTokens), 0);
  const unrealSol = openValue - openCost;
  const pnlSol = realizedSol + unrealSol;
  const pnlUsd = realizedUsd + unrealSol * px;
  const isShadow = state.engine.status === 'SHADOW';
  const total = isShadow ? computePaperEquitySol(state, paperStartSol) * px : portfolioUsd(state);
  const won = closedP.filter((c) => c.proceedsSol > c.entrySol).length;
  const winRate = closedP.length ? (won / closedP.length) * 100 : null;
  const enabled = state.kols.filter((k) => k.enabled).length;
  const kolFills = state.feed.filter((e) => e.ts >= dateRange.start && e.ts <= dateRange.end && e.kind === 'kol_buy' && e.outcome === 'filled').length;
  const shadow = state.engine.status === 'SHADOW';
  const killed = state.engine.status === 'KILLED';
  const now = new Date();
  const dateStr = `${now.toLocaleDateString('en-GB', { weekday: 'long' })}, ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;

  const engineOnline = state.engineSource === 'bridge';
  const baseTotal = total - pnlUsd;
  const totalPnlPct = baseTotal > 0 ? (pnlUsd / baseTotal) * 100 : 0;

  const exportCsv = () => {
    const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [['closed_at', 'symbol', 'mint', 'kol', 'venue', 'entry_sol', 'proceeds_sol', 'pnl_sol', 'exit']];
    for (const c of closedP) rows.push([new Date(c.closedAt).toISOString(), c.symbol, c.mint, state.kols.find((k) => k.id === c.kolId)?.label ?? 'launch', c.venue, c.entrySol.toFixed(4), c.proceedsSol.toFixed(4), (c.proceedsSol - c.entrySol).toFixed(4), c.exitReason]);
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `whal-closed-positions-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  const btn = 'inline-flex h-9 items-center gap-2 rounded-[0.7rem] border px-4 text-[0.9rem] font-medium';
  const head: Record<Tab, { title: string; meta: ReactNode; action?: ReactNode }> = {
    positions: {
      title: 'Active positions',
      meta: <><span><b className="font-semibold text-fg">{open.length}</b> open</span><Sep /><span>Value <b className="font-semibold tabular-nums text-fg">{fmtUsd(openValue * px)}</b></span><Sep /><span>Unrealized <b className={cx('font-semibold tabular-nums', tone(unrealSol))}>{fmtUsd(unrealSol * px, true)}</b> <span className="tabular-nums">({fmtSol(unrealSol, 2, true)} SOL)</span></span></>,
      action: engineOnline ? undefined : <Badge tone="warn">Engine offline</Badge>,
    },
    closed: {
      title: 'Closed positions',
      meta: <><span><b className="font-semibold text-fg">{closedP.length}</b> trades</span><Sep /><span>Win rate <b className="font-semibold text-fg">{winRate == null ? '—' : `${Math.round(winRate)}%`}</b></span><Sep /><span>Realized <b className={cx('font-semibold tabular-nums', tone(realizedSol))}>{fmtUsd(realizedUsd, true)}</b> <span className="tabular-nums">({fmtSol(realizedSol, 2, true)} SOL)</span></span></>,
      action: <button type="button" onClick={exportCsv} disabled={!closedP.length} className={cx(btn, 'border-line bg-card hover:bg-raised disabled:opacity-45')}><Upload className="size-4" aria-hidden />Export</button>,
    },
    signals: {
      title: 'Live signals',
      meta: <><span><b className="font-semibold text-fg">{signalsP.length}</b> events</span><Sep /><span>Filled <b className="font-semibold text-fg">{signalsP.filter((e) => e.outcome === 'filled').length}</b></span><Sep /><span>Missed <b className="font-semibold text-fg">{signalsP.filter((e) => e.outcome === 'missed' || e.outcome === 'expired').length}</b></span>{frozen && <><Sep /><span className="text-sky-300">Frozen</span></>}</>,
      action: <button type="button" aria-pressed={!!frozen} onClick={() => setFrozen(frozen ? null : state.feed)} className={cx(btn, frozen ? 'border-sky-400/40 bg-sky-400/10 text-sky-300' : 'border-line bg-card hover:bg-raised')}><Snowflake className="size-4" aria-hidden />{frozen ? 'Resume' : 'Freeze'}</button>,
    },
  };

  const current: { kolId: string | null }[] = tab === 'positions' ? open : tab === 'closed' ? closedP : signalsP;
  const srcCount = (s: Source) => bySource(current, s).length;

  return (
    <div className="mx-auto max-w-[96rem]">
      {/* header */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[2.25rem] font-bold leading-tight tracking-tight">Overview</h1>
          <p className="mt-1 text-[0.95rem] text-fg2">{dateStr} · Watching {enabled} KOL{enabled === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <button type="button" role="switch" aria-checked={shadow} disabled={busy || killed || loading || !engineOnline}
            title={!engineOnline ? 'Connect the Rust engine to toggle shadow mode' : undefined}
            onClick={() => run({ type: 'engine.set', status: shadow ? 'RUNNING' : 'SHADOW' }, shadow ? 'Shadow mode off: engine running' : 'Shadow mode on: nothing is sent')}
            className="inline-flex h-10 items-center gap-3 rounded-[0.75rem] border border-line bg-card pl-4 pr-2.5 text-[0.95rem] font-medium hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50">
            Shadow mode
            <span className={cx('relative h-6 w-10 rounded-full transition-colors', shadow ? 'bg-emerald-500' : 'bg-line2')}><span className={cx('absolute top-0.5 size-5 rounded-full bg-white transition-[left]', shadow ? 'left-[1.15rem]' : 'left-0.5')} /></span>
          </button>
          <Link href="/execution" className="inline-flex h-10 items-center gap-2 rounded-[0.75rem] border border-line bg-card px-4 text-[0.95rem] font-medium hover:bg-raised"><Zap className="size-4" aria-hidden />Landers</Link>
          <PnlCalendarButton closed={state.closed} defaultPaper={shadow} />
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {/* KPI card */}
      <section aria-label="Summary" className="mb-8 grid overflow-hidden rounded-[1.4rem] border border-line2 bg-panel sm:grid-cols-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_1fr] stat-grid">
        {loading ? Array.from({ length: 5 }).map((_, i) => <div key={i} className="px-6 py-6"><Skeleton className="h-4 w-24" /><Skeleton className="mt-4 h-9 w-36" /><Skeleton className="mt-3 h-3 w-28" /></div>) : <>
          <Kpi first label="Total balance" sub={<><span className={tone(pnlUsd)}>{fmtUsd(pnlUsd, true)}</span><PctChip v={totalPnlPct} />{dateRange.label.toLowerCase()}</>}>{fmtUsd(total)}</Kpi>
          <Kpi label="Period PnL" extra={
            <span role="group" aria-label="Units" className="inline-flex rounded-lg bg-raised p-0.5">
              {(['USD', 'SOL'] as const).map((u) => <button key={u} type="button" aria-pressed={unit === u} onClick={() => setUnit(u)} className={cx('rounded-md px-2 py-0.5 text-[0.72rem] font-semibold', unit === u ? 'bg-[#2b2b31] text-fg' : 'text-muted')}>{u}</button>)}
            </span>}
            sub={<>Realized {unit === 'USD' ? fmtUsd(realizedUsd, true) : fmtSol(realizedSol, 3, true)} · Open {unit === 'USD' ? fmtUsd(unrealSol * px, true) : fmtSol(unrealSol, 3, true)}</>}>
            <span className={tone(pnlSol)}>{unit === 'USD' ? fmtUsd(pnlUsd, true) : `${fmtSol(pnlSol, 3, true)} SOL`}</span>
          </Kpi>
          <Kpi label="Open positions" sub={<>{open.length} open · cost {fmtSol(openCost, 2)} SOL</>}>{fmtUsd(openValue * px)}</Kpi>
          <Kpi label="Win rate" sub={<>{won} won · {closedP.length - won} lost · {closedP.length} closed</>}>
            {winRate == null ? '—' : `${winRate.toFixed(1)}%`}
            <span className={cx('mt-3 block h-1.5 overflow-hidden rounded-full', winRate == null ? 'bg-line2' : 'bg-rose-400/45')}><span className="block h-full rounded-full bg-emerald-400" style={{ width: `${winRate ?? 0}%` }} /></span>
          </Kpi>
          <Kpi label="KOLs" sub={<>{enabled} enabled · {kolFills} buys {dateRange.label.toLowerCase()}</>}>{state.kols.length}</Kpi>
        </>}
      </section>

      {/* tabs + source filter */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Views" className="inline-flex max-w-full gap-1 overflow-x-auto rounded-[0.9rem] border border-line bg-panel p-1">
          {([['positions', 'Positions', open.length], ['closed', 'Closed', closedP.length], ['signals', 'Live signals', signalsP.length]] as const).map(([v, l, n]) => (
            <button key={v} role="tab" type="button" aria-selected={tab === v} onClick={() => setTab(v)}
              className={cx('inline-flex items-center gap-2.5 whitespace-nowrap rounded-[0.65rem] px-4 py-2 text-[0.95rem] font-medium', tab === v ? 'bg-raised text-fg' : 'text-fg2 hover:text-fg')}>
              {v === 'signals' && <span aria-hidden className="size-1.5 rounded-full bg-emerald-400" />}{l}<span className="text-[0.8rem] tabular-nums text-muted">{n}</span>
            </button>
          ))}
        </div>
        <div role="group" aria-label="Source" className="inline-flex gap-1 rounded-[0.9rem] border border-line bg-panel p-1">
          {([['all', 'All'], ['kol', 'KOL'], ['launch', 'Launch']] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={source === v} onClick={() => setSource(v)}
              className={cx('inline-flex items-center gap-2.5 rounded-[0.65rem] px-4 py-2 text-[0.95rem] font-medium', source === v ? 'bg-raised text-fg' : 'text-fg2 hover:text-fg')}>
              {l}<span className="text-[0.8rem] tabular-nums text-muted">{srcCount(v)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* table card */}
      <section role="tabpanel" aria-label={head[tab].title} className="relative overflow-hidden rounded-[1.4rem] border border-line2 bg-panel">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 pb-4 pt-5 sm:px-7">
          <div>
            <h2 className="text-[1.35rem] font-semibold tracking-tight">{head[tab].title}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.92rem] text-fg2">{head[tab].meta}</div>
          </div>
          {head[tab].action}
        </header>
        <div className="overflow-x-auto">
          {loading ? <TableSkeleton rows={8} cols={6} />
            : tab === 'positions' ? <PositionsTab rows={bySource(open, source)} unit={unit} />
            : tab === 'closed' ? <ClosedTab rows={bySource(closedP, source).slice(0, 100)} unit={unit} />
            : <SignalsTab rows={bySource(signalsP, source).slice(0, 100)} />}
        </div>
      </section>
    </div>
  );
}

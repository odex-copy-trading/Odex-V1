'use client';

import { useState } from 'react';
import { ArrowUpRight, Copy, Layers, LoaderCircle, Radar, Recycle } from '@/components/icons';
import { EmptyState, TableSkeleton, cx } from '@/components/ui';
import { kolLabel, useTerminal } from '@/lib/store';
import { fmtAgo, fmtClock, fmtCompact, fmtSlot, fmtSol, fmtUsd, tone } from '@/lib/format';
import type { ClosedPosition, FeedEvent, Position, TerminalState } from '@/lib/types';
import { LANDER_NAME, NumCell, PctChip, REVERT_META, RTd, RTh, RevertBar, StatusChip, TokenCell, VENUE_SHORT } from './shared';

const at = (s: TerminalState, kolId: string | null) => (kolId ? <span className="font-medium text-accent">@{kolLabel(s, kolId)}</span> : <span className="text-sky-300">new launch</span>);
const usd = (sol: number, px: number, sign = false) => fmtUsd(sol * px, sign);

// ---------------- open positions ----------------
function SellButtons({ p }: { p: Position }) {
  const { send, toast } = useTerminal();
  const [busy, setBusy] = useState<number | null>(null);
  const inFlight = p.pendingSell ?? busy;
  const sell = async (pct: 15 | 25 | 33 | 50 | 100) => {
    setBusy(pct);
    try { await send({ type: 'position.sell', positionId: p.id, pct }); toast(`Sell ${pct}% $${p.symbol} sent`, 'ok'); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="flex justify-end gap-1.5" role="group" aria-label={`Panic sell $${p.symbol}`}>
      {([15, 25, 33, 50, 100] as const).map((pct) => (
        <button key={pct} type="button" disabled={inFlight != null} onClick={(e) => { e.stopPropagation(); sell(pct); }} aria-label={`Sell ${pct}% of $${p.symbol}`}
          className={cx('inline-flex h-8 min-w-10 items-center justify-center rounded-[0.55rem] px-1.5 text-[0.78rem] font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            pct === 100 ? 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25' : 'bg-raised text-fg hover:bg-hover')}>
          {inFlight === pct ? <LoaderCircle className="size-3.5 animate-spin" aria-label="Selling" /> : `${pct}%`}
        </button>
      ))}
    </div>
  );
}

export function PositionsTab({ rows, unit }: { rows: Position[]; unit: 'USD' | 'SOL' }) {
  const { state } = useTerminal();
  const px = state.balances.solUsd;
  if (!rows.length) return <EmptyState icon={Layers} title="No open positions">Filled bursts open a position here, with 15 / 25 / 33 / 50 / 100% panic-sell on every row.</EmptyState>;
  return (
    <table className="w-full">
      <thead><tr><RTh>Token</RTh><RTh right className="hidden lg:table-cell">Entry</RTh><RTh right className="hidden md:table-cell">Value</RTh><RTh right>P&amp;L</RTh><RTh className="hidden sm:table-cell">Status</RTh><RTh right className="hidden xl:table-cell">Opened</RTh><RTh right>Panic sell</RTh></tr></thead>
      <tbody>
        {rows.map((p) => {
          const rem = p.initialTokens > 0 ? p.tokens / p.initialTokens : 0, value = p.tokens * p.price, banked = p.proceedsSol ?? 0, pnl = value + banked - p.entrySol, pct = p.entrySol > 0 ? (pnl / p.entrySol) * 100 : 0;
          return (
            <tr key={p.id} className="hover:bg-card">
              <RTd><TokenCell symbol={p.symbol} badge={VENUE_SHORT[p.venue]} mint={p.mint} ts={p.openedAt} image={p.image} sub={at(state, p.kolId)} /></RTd>
              <RTd right className="hidden lg:table-cell"><NumCell top={usd(p.entrySol, px)} bottom={`${fmtSol(p.entrySol)} SOL`} /></RTd>
              <RTd right className="hidden md:table-cell"><NumCell top={usd(value, px)} bottom={`${fmtSol(value)} SOL`} /></RTd>
              <RTd right>
                <NumCell top={<span className="inline-flex items-center gap-2"><span className={tone(pnl)}>{unit === 'USD' ? usd(pnl, px, true) : `${fmtSol(pnl, 4, true)} SOL`}</span><PctChip v={pct} /></span>}
                  bottom={unit === 'USD' ? `${fmtSol(pnl, 4, true)} SOL` : usd(pnl, px, true)} />
              </RTd>
              <RTd className="hidden sm:table-cell">{p.pendingSell ? <StatusChip tone="warn">Selling {p.pendingSell}%…</StatusChip> : <StatusChip>{rem > 0.999 ? 'Holding' : `${Math.round(rem * 100)}% left`}</StatusChip>}</RTd>
              <RTd right className="hidden xl:table-cell"><NumCell top={`#${fmtSlot(p.openedSlot)}`} bottom={fmtClock(p.openedAt)} /></RTd>
              <RTd right><SellButtons p={p} /></RTd>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------- closed positions ----------------
const EXIT_TONE: Record<string, 'neutral' | 'warn'> = { 'Liquidity floor': 'warn', 'Time cap': 'warn' };

export function ClosedTab({ rows, unit }: { rows: ClosedPosition[]; unit: 'USD' | 'SOL' }) {
  const { state, toast } = useTerminal();
  if (!rows.length) return <EmptyState icon={Recycle} title="No closed positions in this period">Try a longer period.</EmptyState>;
  const copy = async (c: ClosedPosition) => {
    const pnl = c.proceedsSol - c.entrySol;
    try { await navigator.clipboard.writeText(`$${c.symbol} ${c.exitReason} ${fmtSol(pnl, 4, true)} SOL (${((pnl / c.entrySol) * 100).toFixed(1)}%)`); toast('Row copied', 'ok'); }
    catch { toast('Copy failed', 'error'); }
  };
  return (
    <table className="w-full">
      <thead><tr><RTh>Token</RTh><RTh right className="hidden md:table-cell">Bought</RTh><RTh right className="hidden md:table-cell">Sold</RTh><RTh right>P&amp;L</RTh><RTh className="hidden sm:table-cell">Exit</RTh><RTh right className="hidden lg:table-cell">Opened</RTh><RTh className="hidden xl:table-cell"><span className="sr-only">Actions</span></RTh></tr></thead>
      <tbody>
        {rows.map((c) => {
          const pnl = c.proceedsSol - c.entrySol, pct = c.entrySol > 0 ? (pnl / c.entrySol) * 100 : 0, held = Math.max(0, (c.closedAt - c.openedAt) / 1000);
          return (
            <tr key={c.id} className="hover:bg-card">
              <RTd><TokenCell symbol={c.symbol} badge={VENUE_SHORT[c.venue]} mint={c.mint} ts={c.openedAt} image={c.image} sub={<>held {held < 60 ? `${Math.round(held)}s` : `${Math.round(held / 60)}m`} · {at(state, c.kolId)}</>} /></RTd>
              <RTd right className="hidden md:table-cell"><NumCell top={usd(c.entrySol, c.solUsd)} bottom={`${fmtSol(c.entrySol)} SOL`} /></RTd>
              <RTd right className="hidden md:table-cell"><NumCell top={usd(c.proceedsSol, c.solUsd)} bottom={`${fmtSol(c.proceedsSol)} SOL`} /></RTd>
              <RTd right>
                <NumCell top={<span className="inline-flex items-center gap-2"><span className={tone(pnl)}>{unit === 'USD' ? usd(pnl, c.solUsd, true) : `${fmtSol(pnl, 4, true)} SOL`}</span><PctChip v={pct} /></span>}
                  bottom={unit === 'USD' ? `${fmtSol(pnl, 4, true)} SOL` : usd(pnl, c.solUsd, true)} />
              </RTd>
              <RTd className="hidden sm:table-cell"><StatusChip tone={EXIT_TONE[c.exitReason] ?? 'neutral'}>{c.exitReason}</StatusChip></RTd>
              <RTd right className="hidden lg:table-cell"><NumCell top={`${fmtAgo(c.openedAt)} ago`} bottom={`closed ${fmtAgo(c.closedAt)} ago`} /></RTd>
              <RTd className="hidden xl:table-cell">
                <div className="flex justify-end gap-2">
                  <a href={`https://solscan.io/token/${encodeURIComponent(c.mint)}`} target="_blank" rel="noopener noreferrer" aria-label={`Open $${c.symbol} on Solscan`} className="grid size-8 place-items-center rounded-[0.55rem] bg-raised text-fg2 hover:bg-hover hover:text-fg"><ArrowUpRight className="size-4" /></a>
                  <button type="button" onClick={() => copy(c)} aria-label={`Copy $${c.symbol} row`} className="grid size-8 place-items-center rounded-[0.55rem] bg-raised text-fg2 hover:bg-hover hover:text-fg"><Copy className="size-4" /></button>
                </div>
              </RTd>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------- live signals ----------------
const OUTCOME: Record<FeedEvent['outcome'], { label: string; tone: 'neutral' | 'warn' | 'ok' | 'info' | 'bad' }> = {
  filled: { label: 'Filled', tone: 'ok' }, missed: { label: 'Missed', tone: 'neutral' }, expired: { label: 'Expired', tone: 'warn' },
  shadow: { label: 'Paper', tone: 'info' }, sold: { label: 'Sold', tone: 'neutral' },
};

export function SignalsTab({ rows }: { rows: FeedEvent[] }) {
  const { state } = useTerminal();
  if (!rows.length) return <EmptyState icon={Radar} title="Waiting for shred events">Detections from enabled KOLs and new launches stream here.</EmptyState>;
  return (
    <table className="w-full">
      <thead><tr><RTh>Token</RTh><RTh right className="hidden md:table-cell">Size</RTh><RTh right className="hidden lg:table-cell">Fan-out</RTh><RTh className="hidden lg:table-cell">Winner</RTh><RTh className="hidden xl:table-cell">Reverts</RTh><RTh>Outcome</RTh><RTh right className="hidden sm:table-cell">Slot</RTh></tr></thead>
      <tbody>
        {rows.map((e) => {
          const rev = REVERT_META.reduce((a, m) => a + e.reverts[m.key], 0);
          return (
            <tr key={e.id} className="flash-in hover:bg-card">
              <RTd><TokenCell symbol={e.symbol} badge={e.kind === 'sell' ? 'SELL' : e.kind === 'launch' ? 'LAUNCH' : 'KOL BUY'} mint={e.mint} ts={e.ts} image={e.image} sub={<>{VENUE_SHORT[e.venue].toLowerCase()} · {at(state, e.kolId)}</>} /></RTd>
              <RTd right className="hidden md:table-cell"><NumCell top={`${fmtSol(e.sizeSol, e.kind === 'sell' ? 4 : 2)} SOL`} bottom={e.kind === 'sell' ? 'proceeds' : 'buy size'} /></RTd>
              <RTd right className="hidden lg:table-cell"><NumCell top={e.fanout ? `${e.fanout} tx` : '—'} bottom={e.cuUsed ? `${fmtCompact(e.cuUsed)} CU` : 'not sent'} /></RTd>
              <RTd className="hidden lg:table-cell"><div className="text-[0.95rem]">{e.winner ? LANDER_NAME[e.winner] : <span className="text-muted">—</span>}</div><div className="text-[0.88rem] text-muted">{e.fanout ? `${rev} reverted` : ''}</div></RTd>
              <RTd className="hidden xl:table-cell">{e.fanout && e.kind !== 'sell' ? <div className="w-40"><RevertBar r={e.reverts} total={e.fanout} /><div className="mt-1.5 truncate text-[0.75rem] text-muted tabular-nums">{REVERT_META.filter((m) => e.reverts[m.key]).map((m) => `${m.short} ${e.reverts[m.key]}`).join(' · ') || 'none'}</div></div> : <span className="text-[0.88rem] text-muted">{e.note ?? '—'}</span>}</RTd>
              <RTd><StatusChip tone={OUTCOME[e.outcome].tone}>{OUTCOME[e.outcome].label}</StatusChip></RTd>
              <RTd right className="hidden sm:table-cell"><NumCell top={`#${fmtSlot(e.slot)}`} bottom={fmtClock(e.ts)} /></RTd>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export { TableSkeleton };

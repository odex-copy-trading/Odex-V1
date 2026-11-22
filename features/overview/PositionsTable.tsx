'use client';

import { useState } from 'react';
import { Layers, LoaderCircle } from '@/components/icons';
import { Badge, Card, CardHeader, EmptyState, TableSkeleton, Td, Th, cx } from '@/components/ui';
import { kolLabel, useTerminal } from '@/lib/store';
import { fmtAgo, fmtPct, fmtSol, shortKey, tone } from '@/lib/format';
import type { Position } from '@/lib/types';

const SELL_PCTS = [15, 25, 33, 50, 100] as const;
type SellPct = (typeof SELL_PCTS)[number];

function view(p: Position) {
  const remaining = p.tokens / p.initialTokens;
  const value = p.tokens * p.price;
  const cost = p.entrySol * remaining;
  const pnl = value - cost;
  return { remaining, value, pnl, pnlPct: cost > 0 ? (pnl / cost) * 100 : 0 };
}

function SellButtons({ p }: { p: Position }) {
  const { send, toast } = useTerminal();
  const [busy, setBusy] = useState<number | null>(null);
  const inFlight = p.pendingSell ?? busy;
  const sell = async (pct: SellPct) => {
    setBusy(pct);
    try {
      await send({ type: 'position.sell', positionId: p.id, pct });
      toast(`Sell ${pct}% $${p.symbol} sent`, 'ok');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex justify-end gap-1" role="group" aria-label={`Panic sell $${p.symbol}`}>
      {SELL_PCTS.map((pct) => (
        <button key={pct} type="button" disabled={inFlight != null} onClick={() => sell(pct)}
          aria-label={`Sell ${pct}% of $${p.symbol}`}
          className={cx('num inline-flex h-7 min-w-9 items-center justify-center rounded-md border px-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            pct === 100 ? 'border-rose-500/50 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25' : 'border-line2 bg-raised text-fg hover:bg-hover')}>
          {inFlight === pct ? <LoaderCircle className="size-3.5 animate-spin" aria-label="Selling" /> : `${pct}%`}
        </button>
      ))}
    </div>
  );
}

export function PositionsTable() {
  const { state } = useTerminal();
  const loading = state.connection === 'connecting';
  const rows = state.positions.map((p) => ({ p, v: view(p) }));
  const totValue = rows.reduce((a, r) => a + r.v.value, 0);
  const totPnl = rows.reduce((a, r) => a + r.v.pnl, 0);

  return (
    <Card>
      <CardHeader
        title="Active positions"
        meta={<>
          <span><span className="num text-fg">{rows.length}</span> open</span>
          <span>value <span className="num text-fg">{fmtSol(totValue, 3)} SOL</span></span>
          <span>unrealized <span className={cx('num', tone(totPnl))}>{fmtSol(totPnl, 4, true)} SOL</span></span>
        </>}
        actions={<Badge tone="ok">Live API</Badge>}
      />
      {loading ? <TableSkeleton rows={5} cols={5} /> : rows.length === 0 ? (
        <EmptyState icon={Layers} title="No open positions">Filled bursts open a position here. Panic-sell buttons appear on each row.</EmptyState>
      ) : (
        <>
          {/* desktop/tablet table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-[0.8rem]">
              <thead><tr><Th>Token</Th><Th right>Entry</Th><Th right>Value</Th><Th right>Unrealized</Th><Th>Left</Th><Th right className="hidden 2xl:table-cell">Age</Th><Th right>Panic sell</Th></tr></thead>
              <tbody>
                {rows.map(({ p, v }) => (
                  <tr key={p.id} className="hover:bg-card">
                    <Td>
                      <div className="font-semibold">${p.symbol} <span className="num text-[0.7rem] font-normal text-muted 2xl:hidden">{fmtAgo(p.openedAt)}</span></div>
                      <div className="max-w-[15rem] truncate whitespace-nowrap text-[0.72rem] text-muted" title={`${p.venue} · ${p.mint}`}><span className="text-fg2">{kolLabel(state, p.kolId)}</span> · {p.venue.replace('Raydium ', '')} · <span className="num">{shortKey(p.mint, 3)}</span></div>
                    </Td>
                    <Td right mono>{fmtSol(p.entrySol, 3)}</Td>
                    <Td right mono>{fmtSol(v.value, 4)}</Td>
                    <Td right mono>
                      <div className={tone(v.pnl)}>{fmtSol(v.pnl, 4, true)}</div>
                      <div className={cx('text-[0.72rem]', tone(v.pnl))}>{fmtPct(v.pnlPct)}</div>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-line2 2xl:inline-block" aria-hidden><span className="block h-full bg-accent" style={{ width: `${v.remaining * 100}%` }} /></span>
                        <span className="num text-xs">{Math.round(v.remaining * 100)}%</span>
                      </div>
                    </Td>
                    <Td right mono className="hidden text-fg2 2xl:table-cell">{fmtAgo(p.openedAt)}</Td>
                    <Td right><SellButtons p={p} /></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* mobile cards */}
          <ul className="divide-y divide-line sm:hidden">
            {rows.map(({ p, v }) => (
              <li key={p.id} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">${p.symbol} <span className="num text-xs font-normal text-muted">{Math.round(v.remaining * 100)}% left</span></div>
                    <div className="text-xs text-muted">{kolLabel(state, p.kolId)} · {fmtAgo(p.openedAt)}</div>
                  </div>
                  <div className={cx('num text-right text-sm', tone(v.pnl))}>{fmtSol(v.pnl, 4, true)}<div className="text-xs">{fmtPct(v.pnlPct)}</div></div>
                </div>
                <SellButtons p={p} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

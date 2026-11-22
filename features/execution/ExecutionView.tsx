'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Server } from '@/components/icons';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, TableSkeleton, Td, Th, cx } from '@/components/ui';
import { useTerminal } from '@/lib/store';
import { fmtInt, fmtPct, fmtSol } from '@/lib/format';
import type { LanderStat, RevertBreakdown } from '@/lib/types';
import { REVERT_META } from '@/features/overview/shared';

type Key = 'share' | 'landRate' | 'delta' | 'tip' | 'revert' | 'costPerWin';
const derive = (l: LanderStat, totalWins: number) => ({
  share: totalWins ? (l.wins / totalWins) * 100 : 0,
  landRate: l.sent ? (l.wins / l.sent) * 100 : 0,
  delta: l.wins ? l.slotDeltaSum / l.wins : null,
  tip: l.tipPaidSol,
  revert: l.revertCostSol,
  costPerWin: l.wins ? (l.tipPaidSol + l.revertCostSol) / l.wins : null,
});

export function ExecutionView() {
  const { state } = useTerminal();
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'share', dir: -1 });
  const loading = state.connection === 'connecting';
  const totalWins = state.landers.reduce((a, l) => a + l.wins, 0);
  const totalSent = state.landers.reduce((a, l) => a + l.sent, 0);
  const tips = state.landers.reduce((a, l) => a + l.tipPaidSol, 0);
  const reverts = state.landers.reduce((a, l) => a + l.revertCostSol, 0);

  const rows = useMemo(() => state.landers.map((l) => ({ l, d: derive(l, totalWins) }))
    .sort((a, b) => ((a.d[sort.key] ?? Infinity) - (b.d[sort.key] ?? Infinity)) * sort.dir), [state.landers, totalWins, sort]);

  const agg = useMemo(() => {
    const r: RevertBreakdown = { duplicate: 0, mutex: 0, kolNotLanded: 0, slippage: 0, expired: 0 };
    for (const e of state.feed) if (e.kind !== 'sell') for (const m of REVERT_META) r[m.key] += e.reverts[m.key];
    return r;
  }, [state.feed]);
  const aggTotal = REVERT_META.reduce((a, m) => a + agg[m.key], 0);

  const SortTh = ({ k, children }: { k: Key; children: ReactNode }) => (
    <Th right>
      <button type="button" onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : -1 }))}
        className={cx('inline-flex items-center gap-1 uppercase hover:text-fg', sort.key === k && 'text-fg')}>
        {children}{sort.key === k && <span className="sr-only">{sort.dir === 1 ? ' (sorted ascending)' : ' (sorted descending)'}</span>}{sort.key === k && <ChevronDown className={cx('size-3', sort.dir === 1 && 'rotate-180')} aria-hidden />}
      </button>
    </Th>
  );

  return (
    <>
      <PageHeader title="Execution & landers" sub="SWQoS landing providers, ranked by who actually lands the winning transaction." />
      <Card className="mb-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 stat-grid">
          {[
            ['Tx sent', fmtInt(totalSent)],
            ['Winning lands', fmtInt(totalWins)],
            ['Land rate', fmtPct(totalSent ? (totalWins / totalSent) * 100 : 0, 2, false)],
            ['Tips paid', `${fmtSol(tips, 4)} SOL`],
            ['Revert cost', `${fmtSol(reverts, 4)} SOL`],
          ].map(([l, v]) => (
            <div key={l} className="px-5 py-3">
              <div className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted">{l}</div>
              {loading ? <Skeleton className="mt-2 h-6 w-24" /> : <div className="num mt-1.5 text-xl font-semibold">{v}</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader title="Lander performance matrix" meta={<span>Win share = share of all winning transactions. Slot delta = landed slot minus trigger slot.</span>} />
        {loading ? <TableSkeleton rows={7} cols={8} /> : state.landers.length === 0 ? (
          <EmptyState icon={Server} title="No landers configured">Enable at least one landing provider in Settings.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-[0.8rem]">
              <thead><tr>
                <Th>Provider</Th><SortTh k="share">Win share</SortTh><Th right>Wins / sent</Th><SortTh k="landRate">Land rate</SortTh>
                <SortTh k="delta">Avg slot Δ</SortTh><SortTh k="tip">Tip paid</SortTh><SortTh k="revert">Revert cost</SortTh><SortTh k="costPerWin">Cost / win</SortTh>
              </tr></thead>
              <tbody>
                {rows.map(({ l, d }, i) => (
                  <tr key={l.id} className="hover:bg-card">
                    <Td>
                      <div className="flex items-center gap-2">
                        <span className="num w-4 text-xs text-muted">{i + 1}</span>
                        <span className="font-semibold">{l.name}</span>
                        {!l.enabled && <Badge>Off</Badge>}
                      </div>
                    </Td>
                    <Td right>
                      <div className="flex items-center justify-end gap-2">
                        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line2" aria-hidden><span className="block h-full bg-emerald-400" style={{ width: `${d.share}%` }} /></span>
                        <span className="num w-12 text-right">{d.share.toFixed(1)}%</span>
                      </div>
                    </Td>
                    <Td right mono className="text-fg2">{fmtInt(l.wins)} / {fmtInt(l.sent)}</Td>
                    <Td right mono>{d.landRate.toFixed(2)}%</Td>
                    <Td right mono className={d.delta == null ? 'text-muted' : d.delta <= 0.5 ? 'text-emerald-300' : d.delta <= 1 ? 'text-amber-300' : 'text-rose-300'}>{d.delta == null ? '—' : `+${d.delta.toFixed(2)}`}</Td>
                    <Td right mono>{fmtSol(l.tipPaidSol, 4)}</Td>
                    <Td right mono className="text-fg2">{fmtSol(l.revertCostSol, 5)}</Td>
                    <Td right mono>{d.costPerWin == null ? '—' : fmtSol(d.costPerWin, 5)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Revert breakdown" meta={<span>Across the last {state.feed.length} feed events. Reverted txs pay base fee only; tips sit at the end of the tx.</span>} />
        <div className="p-5">
          {loading ? <Skeleton className="h-3 w-full" /> : aggTotal === 0 ? <p className="text-sm text-muted">No reverts yet.</p> : (
            <>
              <div className="flex h-3 overflow-hidden rounded-full bg-line2" role="img" aria-label="Revert share by cause">
                {REVERT_META.map((m) => <span key={m.key} className={m.cls} style={{ width: `${(agg[m.key] / aggTotal) * 100}%` }} />)}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {REVERT_META.map((m) => (
                  <div key={m.key} className="rounded-xl border border-line bg-card px-3 py-2.5">
                    <dt className="flex items-center gap-2 text-xs text-fg2"><span className={cx('size-2 rounded-sm', m.cls)} aria-hidden />{m.label}</dt>
                    <dd className="num mt-1 text-lg font-semibold">{fmtInt(agg[m.key])} <span className="text-xs font-normal text-muted">{((agg[m.key] / aggTotal) * 100).toFixed(1)}%</span></dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </Card>
    </>
  );
}

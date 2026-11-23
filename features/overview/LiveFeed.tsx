'use client';

import { useMemo, useState } from 'react';
import { Radar, Snowflake } from '@/components/icons';
import { Badge, Card, CardHeader, EmptyState, Segmented, Skeleton, cx } from '@/components/ui';
import { kolLabel, useTerminal } from '@/lib/store';
import { fmtClock, fmtCompact, fmtSlot, shortKey } from '@/lib/format';
import type { FeedEvent, LanderId, RevertBreakdown } from '@/lib/types';

export const LANDER_NAME: Record<LanderId, string> = {
  jito: 'Jito', nozomi: 'Nozomi', stellium: 'Stellium', landx: 'LandX', bloom: 'Bloom / BlockRazor', astralane: 'Astralane', glaive: 'Glaive', fastlanes: 'Speed / FastLanes', tpu: 'Direct TPU',
};

export const REVERT_META: { key: keyof RevertBreakdown; label: string; short: string; cls: string }[] = [
  { key: 'duplicate', label: 'Duplicate (ring dedupe)', short: 'dup', cls: 'bg-zinc-500' },
  { key: 'mutex', label: 'Mutex in use', short: 'mutex', cls: 'bg-indigo-400' },
  { key: 'kolNotLanded', label: 'KOL not landed', short: 'kol', cls: 'bg-sky-400' },
  { key: 'slippage', label: 'Slippage', short: 'slip', cls: 'bg-amber-400' },
  { key: 'expired', label: 'Slot TTL expired', short: 'ttl', cls: 'bg-rose-400' },
];

const OUTCOME: Record<FeedEvent['outcome'], { label: string; tone: 'ok' | 'bad' | 'warn' | 'info' | 'neutral' | 'accent' }> = {
  filled: { label: 'FILLED', tone: 'ok' },
  missed: { label: 'MISSED', tone: 'neutral' },
  expired: { label: 'EXPIRED', tone: 'warn' },
  shadow: { label: 'PAPER', tone: 'info' },
  sold: { label: 'SOLD', tone: 'accent' },
};

export function RevertBar({ r, total, className }: { r: RevertBreakdown; total: number; className?: string }) {
  const sum = REVERT_META.reduce((a, m) => a + r[m.key], 0);
  const title = REVERT_META.filter((m) => r[m.key]).map((m) => `${m.label}: ${r[m.key]}`).join(' · ') || 'No reverts';
  return (
    <div className={cx('flex h-1.5 overflow-hidden rounded-full bg-line2', className)} role="img" aria-label={`Reverts: ${title}`} title={title}>
      {total > 0 && REVERT_META.map((m) => r[m.key] ? <span key={m.key} className={m.cls} style={{ width: `${(r[m.key] / total) * 100}%` }} /> : null)}
      {total > 0 && sum < total && <span className="bg-emerald-400" style={{ width: `${((total - sum) / total) * 100}%` }} />}
    </div>
  );
}

type Filter = 'all' | 'filled' | 'missed' | 'sold';

function FeedRow({ e, kol }: { e: FeedEvent; kol: string }) {
  const o = OUTCOME[e.outcome];
  const reverted = REVERT_META.reduce((a, m) => a + e.reverts[m.key], 0);
  return (
    <li className="flash-in grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 text-[0.8rem] last:border-0 sm:px-5">
      <div className="num row-span-2 w-[5.6rem] text-[0.72rem] leading-tight text-muted">
        <div>{fmtClock(e.ts)}</div>
        <div className="text-fg2">#{fmtSlot(e.slot)}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={e.kind === 'sell' ? 'accent' : e.kind === 'launch' ? 'info' : 'neutral'}>{e.kind === 'kol_buy' ? 'KOL BUY' : e.kind === 'launch' ? 'LAUNCH' : 'SELL'}</Badge>
        <span className="font-medium">{kol}</span>
        <span className="text-muted">→</span>
        <span className="font-semibold">${e.symbol}</span>
        <span className="num truncate text-[0.72rem] text-muted" title={e.mint}>{shortKey(e.mint, 4)}</span>
      </div>
      <div className="flex items-center justify-end"><Badge tone={o.tone}>{o.label}</Badge></div>
      <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.72rem] text-fg2">
        {e.fanout > 0 ? (
          <>
            <span><span className="text-muted">fan-out</span> <span className="num text-fg">{e.fanout}</span></span>
            <span><span className="text-muted">winner</span> <span className="text-fg">{e.winner ? LANDER_NAME[e.winner] : '—'}</span></span>
            <span><span className="text-muted">CU</span> <span className="num text-fg">{fmtCompact(e.cuUsed)}</span></span>
            <span><span className="text-muted">{e.kind === 'sell' ? 'out' : 'size'}</span> <span className="num text-fg">{e.sizeSol.toFixed(e.kind === 'sell' ? 4 : 2)} SOL</span></span>
            {e.kind !== 'sell' && (
              <span className="flex basis-full items-center gap-2">
                <RevertBar r={e.reverts} total={e.fanout} className="w-24 shrink-0" />
                <span className="num text-muted">
                  {reverted} rev{REVERT_META.filter((m) => e.reverts[m.key]).map((m) => <span key={m.key}> · {m.short} {e.reverts[m.key]}</span>)}
                </span>
              </span>
            )}
          </>
        ) : null}
        {e.note && <span className={cx(e.outcome === 'missed' && e.fanout === 0 ? 'text-amber-300' : 'text-muted')}>{e.note}</span>}
      </div>
    </li>
  );
}

export function LiveFeed() {
  const { state } = useTerminal();
  const [filter, setFilter] = useState<Filter>('all');
  const [frozen, setFrozen] = useState<FeedEvent[] | null>(null);
  const source = frozen ?? state.feed;
  const items = useMemo(() => source.filter((e) => filter === 'all' || (filter === 'missed' ? e.outcome === 'missed' || e.outcome === 'expired' : e.outcome === filter)).slice(0, 120), [source, filter]);
  const newSince = frozen ? state.feed.findIndex((e) => e.id === frozen[0]?.id) : 0;
  const loading = state.connection === 'connecting';

  return (
    <Card className="flex min-h-0 flex-col">
      <CardHeader
        title={<span className="flex items-center gap-2">Live feed <span className="text-xs font-normal text-muted">shred events &amp; bursts</span></span>}
        meta={<><span><span className="num text-fg">{state.feed.length}</span> events buffered</span>{frozen && <Badge tone="info">Frozen{newSince > 0 ? ` · ${newSince} new` : ''}</Badge>}</>}
        actions={<>
          <Segmented<Filter> label="Filter events" value={filter} onChange={setFilter}
            options={[{ value: 'all', label: 'All' }, { value: 'filled', label: 'Filled' }, { value: 'missed', label: 'Missed' }, { value: 'sold', label: 'Sells' }]} />
          <button type="button" aria-pressed={!!frozen} onClick={() => setFrozen(frozen ? null : state.feed)}
            className={cx('inline-flex h-8 items-center gap-1.5 rounded-[0.6rem] border px-2.5 text-xs font-medium', frozen ? 'border-sky-400/40 bg-sky-400/10 text-sky-300' : 'border-line bg-card text-fg2 hover:text-fg')}>
            <Snowflake className="size-3.5" aria-hidden />{frozen ? 'Resume' : 'Freeze'}
          </button>
        </>}
      />
      {loading ? (
        <div className="space-y-3 p-5" role="status" aria-label="Loading feed">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Radar} title={filter === 'all' ? 'Waiting for shred events' : 'Nothing matches this filter'}>
          {filter === 'all' ? 'Detections from enabled KOLs and new launches will stream here.' : 'Try another filter.'}
        </EmptyState>
      ) : (
        <ol className="max-h-[calc(100vh-15rem)] min-h-64 overflow-y-auto" aria-label="Feed events, newest first">
          {items.map((e) => <FeedRow key={e.id} e={e} kol={kolLabel(state, e.kolId)} />)}
        </ol>
      )}
    </Card>
  );
}

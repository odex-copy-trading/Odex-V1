'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, Coins, Recycle, Settings, Wallet } from '@/components/icons';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Segmented, Skeleton, TableSkeleton, Td, Th, cx } from '@/components/ui';
import { portfolioUsd, useTerminal } from '@/lib/store';
import { fmtAgo, fmtClock, fmtInt, fmtSlot, fmtSol, fmtUsd, shortKey } from '@/lib/format';

type Prog = 'all' | 'SPL' | 'Token-2022';

export function TreasuryView() {
  const { state } = useTerminal();
  const [prog, setProg] = useState<Prog>('all');
  const loading = state.connection === 'connecting';
  const b = state.balances;
  const invValue = state.inventory.reduce((a, i) => a + i.amount * i.priceUsd, 0);
  const inv = useMemo(() => state.inventory.filter((i) => i.amount > 0 && (prog === 'all' || i.program === prog)).sort((a, z) => z.amount * z.priceUsd - a.amount * a.priceUsd), [state.inventory, prog]);
  const swept = state.sweeps.filter((s) => s.status === 'confirmed');
  const sweptUsd = swept.reduce((a, s) => a + s.usdcOut, 0);

  const cards: [string, string, string][] = [
    ['Native SOL', `${fmtSol(b.sol, 4)}`, fmtUsd(b.sol * b.solUsd)],
    ['WSOL vault', `${fmtSol(b.wsol, 4)}`, fmtUsd(b.wsol * b.solUsd)],
    ['USDC treasury', fmtUsd(b.usdc), 'auto-sweep target'],
    ['Quote inventory', fmtUsd(invValue), `${state.inventory.filter((i) => i.amount > 0).length} assets`],
    ['Portfolio', fmtUsd(portfolioUsd(state)), `SOL @ ${fmtUsd(b.solUsd)}`],
  ];

  const sweepCfg = state.config?.config.treasury;
  const sweepClip = sweepCfg?.clip_wsol ?? 20;
  const sweepThresh = sweepCfg?.trigger_wsol_threshold ?? 50;

  return (
    <>
      <PageHeader title="Treasury & inventory" sub="Liquid balances, WSOL → USDC sweeps, quote-asset inventory and rent reclaimed."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/wallets" className="inline-flex h-9 items-center gap-1.5 rounded-[0.65rem] border border-line bg-card px-3 text-xs font-medium text-fg2 hover:bg-raised hover:text-fg">
              <Wallet className="size-3.5" aria-hidden />Manage wallets
            </Link>
            <Link href="/settings#treasury" className="inline-flex h-9 items-center gap-1.5 rounded-[0.65rem] border border-line bg-card px-3 text-xs font-medium text-fg2 hover:bg-raised hover:text-fg">
              <Settings className="size-3.5" aria-hidden />Auto-sweep settings
            </Link>
          </div>
        } />
      <Card className="mb-4">
        <div className="grid grid-cols-2 lg:grid-cols-5 stat-grid">
          {cards.map(([l, v, s]) => (
            <div key={l} className="min-w-0 px-5 py-3">
              <div className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted">{l}</div>
              {loading ? <><Skeleton className="mt-2 h-6 w-28" /><Skeleton className="mt-1.5 h-3 w-16" /></> : <>
                <div className="num mt-1.5 truncate text-xl font-semibold">{v}</div>
                <div className="num mt-0.5 truncate text-xs text-muted">{s}</div>
              </>}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Auto-sweep history" meta={<><span>WSOL → USDC in {sweepClip} SOL clips above {sweepThresh} SOL</span><span>{swept.length} confirmed · <span className="num text-fg">{fmtUsd(sweptUsd)}</span></span></>} />
          {loading ? <TableSkeleton rows={6} cols={5} /> : state.sweeps.length === 0 ? (
            <EmptyState icon={ArrowRightLeft} title="No sweeps yet">Sweeps run when the WSOL vault is above its threshold.</EmptyState>
          ) : (
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full min-w-[36rem] text-[0.8rem]">
                <thead className="sticky top-0 bg-panel"><tr><Th>Time</Th><Th right>Slot</Th><Th right>WSOL in</Th><Th right>USDC out</Th><Th right>Price</Th><Th>Route</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {state.sweeps.map((s) => (
                    <tr key={s.id} className="hover:bg-card">
                      <Td mono className="text-fg2"><span title={new Date(s.ts).toISOString()}>{fmtClock(s.ts)}</span> <span className="text-[0.72rem] text-muted">{fmtAgo(s.ts)} ago</span></Td>
                      <Td right mono className="text-fg2">#{fmtSlot(s.slot)}</Td>
                      <Td right mono>{s.wsolIn.toFixed(2)}</Td>
                      <Td right mono>{fmtUsd(s.usdcOut)}</Td>
                      <Td right mono className="text-fg2">{s.wsolIn > 0 ? fmtUsd(s.usdcOut / s.wsolIn) : '—'}</Td>
                      <Td className="text-fg2">{s.route}</Td>
                      <Td><Badge tone={s.status === 'confirmed' ? 'ok' : s.status === 'pending' ? 'warn' : 'bad'}>{s.status.toUpperCase()}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="Quote-asset inventory" meta={<span>SPL and Token-2022 holdings used as non-SOL quote assets</span>}
              actions={<Segmented<Prog> label="Token program" value={prog} onChange={setProg} options={[{ value: 'all', label: 'All' }, { value: 'SPL', label: 'SPL' }, { value: 'Token-2022', label: 'Token-2022' }]} />} />
            {loading ? <TableSkeleton rows={5} cols={4} /> : inv.length === 0 ? (
              <EmptyState icon={Coins} title="No holdings for this program" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] text-[0.8rem]">
                  <thead><tr><Th>Asset</Th><Th>Program</Th><Th right>Amount</Th><Th right>Value</Th></tr></thead>
                  <tbody>
                    {inv.map((i) => (
                      <tr key={i.mint} className="hover:bg-card">
                        <Td>
                          <div className="flex items-center gap-2"><span className="font-semibold">{i.symbol}</span><Badge tone={i.kind === 'xStock' ? 'accent' : i.kind === 'Stablecoin' ? 'info' : 'neutral'}>{i.kind}</Badge></div>
                          <div className="text-[0.72rem] text-muted">{i.name} · <span className="num" title={i.mint}>{shortKey(i.mint, 3)}</span></div>
                        </Td>
                        <Td><Badge mono tone={i.program === 'Token-2022' ? 'warn' : 'neutral'}>{i.program}</Badge></Td>
                        <Td right mono>{i.amount >= 1e5 ? fmtInt(i.amount) : i.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}</Td>
                        <Td right mono>{fmtUsd(i.amount * i.priceUsd)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Recycle className="size-4 text-muted" aria-hidden />Rent reclaim</span>} meta={<span>Seeded token accounts are closed after full exits to recover rent.</span>} />
            <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
              {([
                ['Accounts closed', fmtInt(state.rent.accountsClosed), undefined],
                ['SOL reclaimed', fmtSol(state.rent.reclaimedSol, 4), undefined],
                ['Open seeded', fmtInt(state.positions.length), '/?tab=positions'],
                ['Per account', fmtSol(state.rent.rentPerAccountSol, 6), undefined],
              ] as const).map(([l, v, href]) => (
                <div key={l} className="bg-panel px-4 py-3">
                  <dt className="text-[0.7rem] font-semibold uppercase tracking-wider text-muted">{l}</dt>
                  <dd className={cx('num mt-1 text-lg font-semibold', loading && 'text-muted')}>
                    {loading ? '—' : href ? <Link href={href} className="hover:text-accent hover:underline">{v}</Link> : v}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

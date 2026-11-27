'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Copy, Pencil, Plus, Search, Settings, Trash2, Users } from '@/components/icons';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Modal, PageHeader, Select, TableSkeleton, Td, Th, Toggle, cx } from '@/components/ui';
import { useCommand, useTerminal } from '@/lib/store';
import { fmtSlot, fmtSol, shortKey, tone } from '@/lib/format';
import { isPubkey } from '@/lib/pubkey';
import type { CopyMode, Kol, QuoteAsset } from '@/lib/types';

const QUOTES: QuoteAsset[] = ['SOL', 'WSOL', 'USDC', 'BONK'];
const MARGIN_HINT: Record<QuoteAsset, string> = {
  SOL: 'Trigger when the wallet’s SOL balance drops by more than this (SOL).',
  WSOL: 'Trigger on a WSOL account balance drop larger than this (WSOL).',
  USDC: 'Trigger on a USDC account balance drop larger than this (USDC).',
  BONK: 'Trigger on a BONK account balance drop larger than this (BONK).',
};

type Draft = {
  id?: string;
  label: string;
  pubkey: string;
  quote: QuoteAsset;
  triggerMargin: string;
  buySizeSol: string;
  maxCurveReserveSol: string;
  minKolBuySol: string;
  maxKolBuySol: string;
  copyMode: CopyMode;
  copyPct: string;
  enabled: boolean;
};
const blank: Draft = {
  label: '',
  pubkey: '',
  quote: 'SOL',
  triggerMargin: '0.02',
  buySizeSol: '2',
  maxCurveReserveSol: '60',
  minKolBuySol: '',
  maxKolBuySol: '',
  copyMode: 'fixed',
  copyPct: '100',
  enabled: true,
};

function validate(d: Draft, kols: Kol[]) {
  const e: Partial<Record<keyof Draft, string>> = {};
  const n = (v: string) => Number(v);
  if (!d.label.trim()) e.label = 'Give this wallet a label.';
  else if (d.label.trim().length > 32) e.label = '32 characters max.';
  if (!isPubkey(d.pubkey)) e.pubkey = 'Enter a valid Solana public key (base58, 32 bytes).';
  else if (kols.some((k) => k.pubkey === d.pubkey.trim() && k.id !== d.id)) e.pubkey = 'Already on the watchlist.';
  if (!(n(d.triggerMargin) > 0)) e.triggerMargin = 'Must be greater than 0.';
  if (!(n(d.buySizeSol) >= 0.01 && n(d.buySizeSol) <= 100)) e.buySizeSol = 'Between 0.01 and 100 SOL.';
  if (!(n(d.maxCurveReserveSol) > 0)) e.maxCurveReserveSol = 'Must be greater than 0.';
  if (d.minKolBuySol.trim() !== '' && !(n(d.minKolBuySol) >= 0 && n(d.minKolBuySol) <= 10_000)) e.minKolBuySol = '0 to 10,000 SOL.';
  if (d.maxKolBuySol.trim() !== '') {
    if (!(n(d.maxKolBuySol) > 0 && n(d.maxKolBuySol) <= 10_000)) e.maxKolBuySol = 'Must be > 0.';
    else if (d.minKolBuySol.trim() !== '' && n(d.maxKolBuySol) < n(d.minKolBuySol)) e.maxKolBuySol = 'Max must be ≥ min.';
  }
  if (d.copyMode === 'proportional' && !(n(d.copyPct) >= 1 && n(d.copyPct) <= 500)) e.copyPct = 'Between 1% and 500%.';
  return e;
}

function KolModal({ draft, onClose }: { draft: Draft | null; onClose: () => void }) {
  const { state } = useTerminal();
  const { run, busy } = useCommand();
  const [d, setD] = useState<Draft>(draft ?? blank);
  const [touched, setTouched] = useState(false);
  const errors = validate(d, state.kols);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const err = (k: keyof Draft) => (touched ? errors[k] : undefined);

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length) return;
    const minKol = d.minKolBuySol.trim() === '' ? 0 : Number(d.minKolBuySol);
    const maxKol = d.maxKolBuySol.trim() === '' ? null : Number(d.maxKolBuySol);
    const ok = await run({ type: 'kol.upsert', kol: {
      id: d.id ?? `kol_${Date.now().toString(36)}`, label: d.label.trim(), pubkey: d.pubkey.trim(), quote: d.quote,
      triggerMargin: Number(d.triggerMargin), buySizeSol: Number(d.buySizeSol), maxCurveReserveSol: Number(d.maxCurveReserveSol),
      minKolBuySol: minKol, maxKolBuySol: maxKol, copyMode: d.copyMode, copyPct: Number(d.copyPct) || 100,
      enabled: d.enabled,
    } }, d.id ? 'Wallet updated' : 'Wallet added to watchlist');
    if (ok) onClose();
  };

  return (
    <Modal open onClose={onClose} title={d.id ? `Edit ${d.label || 'wallet'}` : 'Track a wallet'}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save(); }} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" htmlFor="k-label" error={err('label')}><Input id="k-label" value={d.label} maxLength={32} invalid={!!err('label')} onChange={(e) => set('label', e.target.value)} /></Field>
          <Field label="Quote asset" htmlFor="k-quote"><Select id="k-quote" value={d.quote} onChange={(e) => set('quote', e.target.value as QuoteAsset)}>{QUOTES.map((q) => <option key={q}>{q}</option>)}</Select></Field>
        </div>
        <Field label="Wallet public key" htmlFor="k-pub" error={err('pubkey')} hint="Public address only. Never paste a private key or seed phrase.">
          <Input id="k-pub" className="num" value={d.pubkey} autoComplete="off" spellCheck={false} invalid={!!err('pubkey')} onChange={(e) => set('pubkey', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Min trader buy (SOL)" htmlFor="k-min-kol" error={err('minKolBuySol')} hint="Skip small chart top-ups (e.g. 0.025 / 0.2 SOL). Blank = any.">
            <Input id="k-min-kol" className="num" inputMode="decimal" placeholder="e.g. 1" value={d.minKolBuySol} invalid={!!err('minKolBuySol')} onChange={(e) => set('minKolBuySol', e.target.value)} />
          </Field>
          <Field label="Max trader buy (SOL)" htmlFor="k-max-kol" error={err('maxKolBuySol')} hint="Optional upper cap (e.g. 2 SOL). Blank = no max.">
            <Input id="k-max-kol" className="num" inputMode="decimal" placeholder="No max" value={d.maxKolBuySol} invalid={!!err('maxKolBuySol')} onChange={(e) => set('maxKolBuySol', e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Copy sizing mode" htmlFor="k-copy-mode">
            <Select id="k-copy-mode" value={d.copyMode} onChange={(e) => set('copyMode', e.target.value as CopyMode)}>
              <option value="fixed">Fixed SOL amount</option>
              <option value="proportional">Proportional (% of trader buy)</option>
            </Select>
          </Field>
          {d.copyMode === 'proportional' ? (
            <Field label="Copy % of trader buy" htmlFor="k-copy-pct" error={err('copyPct')} hint="Clamped to your Settings min/max buy size.">
              <Input id="k-copy-pct" className="num" inputMode="decimal" placeholder="50" value={d.copyPct} invalid={!!err('copyPct')} onChange={(e) => set('copyPct', e.target.value)} />
            </Field>
          ) : (
            <Field label="Buy size (SOL)" htmlFor="k-size" error={err('buySizeSol')}>
              <Input id="k-size" className="num" inputMode="decimal" value={d.buySizeSol} invalid={!!err('buySizeSol')} onChange={(e) => set('buySizeSol', e.target.value)} />
            </Field>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Trigger margin (${d.quote})`} htmlFor="k-margin" error={err('triggerMargin')} hint={MARGIN_HINT[d.quote]}>
            <Input id="k-margin" className="num" inputMode="decimal" value={d.triggerMargin} invalid={!!err('triggerMargin')} onChange={(e) => set('triggerMargin', e.target.value)} />
          </Field>
          <Field label="Max curve reserve (SOL)" htmlFor="k-curve" error={err('maxCurveReserveSol')} hint="Skip if the pool already holds more than this.">
            <Input id="k-curve" className="num" inputMode="decimal" value={d.maxCurveReserveSol} invalid={!!err('maxCurveReserveSol')} onChange={(e) => set('maxCurveReserveSol', e.target.value)} />
          </Field>
        </div>
        <label className="flex items-center gap-3 text-sm"><Toggle checked={d.enabled} onChange={(v) => set('enabled', v)} label="Enabled" /> Enabled</label>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" loading={busy}>{d.id ? 'Save changes' : 'Add wallet'}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function WatchlistView() {
  const { state, toast } = useTerminal();
  const { run } = useCommand();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Draft | null | undefined>(undefined); // undefined = closed, null = new
  const [remove, setRemove] = useState<Kol | null>(null);
  const loading = state.connection === 'connecting';
  const [focusId, setFocusId] = useState<string | null>(null);
  // Deep links from global search: #add=<pubkey> opens the form, #<kolId> highlights a row.
  useEffect(() => {
    const read = () => {
      const h = window.location.hash;
      const frag = decodeURIComponent(h.slice(h.lastIndexOf('#') + 1));
      if (frag.startsWith('add=')) setEdit({ ...blank, pubkey: frag.slice(4) });
      else if (frag.startsWith('kol_')) {
        setFocusId(frag);
        requestAnimationFrame(() => document.getElementById(frag)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        setTimeout(() => setFocusId(null), 2500);
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return state.kols.filter((k) => !s || k.label.toLowerCase().includes(s) || k.pubkey.toLowerCase().includes(s));
  }, [state.kols, q]);

  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast('Address copied', 'ok'); } catch { toast('Copy failed', 'error'); } };
  const toDraft = (k: Kol): Draft => ({
    id: k.id, label: k.label, pubkey: k.pubkey, quote: k.quote,
    triggerMargin: String(k.triggerMargin), buySizeSol: String(k.buySizeSol), maxCurveReserveSol: String(k.maxCurveReserveSol),
    minKolBuySol: k.minKolBuySol && k.minKolBuySol > 0 ? String(k.minKolBuySol) : '',
    maxKolBuySol: k.maxKolBuySol != null && k.maxKolBuySol > 0 ? String(k.maxKolBuySol) : '',
    copyMode: k.copyMode ?? 'fixed',
    copyPct: String(k.copyPct ?? 100),
    enabled: k.enabled,
  });

  return (
    <>
      <PageHeader title="KOL watchlist" sub={loading ? 'Loading…' : `${state.kols.length} wallets · ${state.kols.filter((k) => k.enabled).length} enabled`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/settings#strategy" className="inline-flex h-9 items-center gap-1.5 rounded-[0.65rem] border border-line bg-card px-3 text-xs font-medium text-fg2 hover:bg-raised hover:text-fg">
              <Settings className="size-3.5" aria-hidden />Buy guards
            </Link>
            <Button variant="primary" icon={Plus} onClick={() => setEdit(null)} disabled={loading}>Track wallet</Button>
          </div>
        } />
      <Card className="p-0.5">
        <CardHeader title={<span className="text-[1.1rem]">Tracked wallets</span>} meta={<span className="text-[0.88rem]">Win rate and PnL are from this bot’s own fills on each wallet.</span>}
          actions={<div className="relative w-72 max-w-full"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted" aria-hidden /><Input aria-label="Search wallets" placeholder="Search label or address" className="h-10 pl-9 text-[0.9rem]" value={q} onChange={(e) => setQ(e.target.value)} /></div>} />
        {loading ? <TableSkeleton rows={6} cols={7} /> : rows.length === 0 ? (
          <EmptyState icon={Users} title={state.kols.length ? 'No wallets match your search' : 'No wallets tracked'} action={!state.kols.length && <Button variant="primary" icon={Plus} onClick={() => setEdit(null)}>Track wallet</Button>}>
            {state.kols.length ? 'Try a different label or address.' : 'Add a KOL wallet to start detecting its buys.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[66rem] text-[0.9rem] [&_th]:px-5 [&_th]:py-3.5 [&_th]:text-[0.76rem] [&_td]:px-5 [&_td]:py-4">
              <thead><tr><Th>On</Th><Th>Wallet</Th><Th>Quote</Th><Th right>Trader size</Th><Th right>Copy size</Th><Th right>Max curve</Th><Th right>Win rate</Th><Th right>Realized PnL</Th><Th right>Last seen</Th><Th right><span className="sr-only">Actions</span></Th></tr></thead>
              <tbody>
                {rows.map((k) => {
                  const n = k.stats.wins + k.stats.losses;
                  const wr = n ? (k.stats.wins / n) * 100 : null;
                  const minK = k.minKolBuySol ?? 0;
                  const maxK = k.maxKolBuySol ?? null;
                  const rangeLabel = minK > 0 && maxK != null ? `${minK}–${maxK}` : minK > 0 ? `≥ ${minK}` : maxK != null ? `≤ ${maxK}` : 'Any';
                  return (
                    <tr key={k.id} id={k.id} className={cx('hover:bg-card', !k.enabled && 'opacity-60', focusId === k.id && 'flash-in bg-accent/10')}>
                      <Td><Toggle checked={k.enabled} label={`${k.enabled ? 'Disable' : 'Enable'} ${k.label}`} onChange={(v) => run({ type: 'kol.toggle', id: k.id, enabled: v }, `${k.label} ${v ? 'enabled' : 'disabled'}`)} /></Td>
                      <Td>
                        <div className="text-[0.95rem] font-semibold"><Link href={`/?tab=closed&kol=${encodeURIComponent(k.id)}`} className="hover:text-accent hover:underline">{k.label}</Link></div>
                        <div className="mt-0.5 flex items-center gap-1 text-[0.8rem] text-muted">
                          <span className="num" title={k.pubkey}>{shortKey(k.pubkey, 5)}</span>
                          <button type="button" onClick={() => copy(k.pubkey)} aria-label={`Copy ${k.label} address`} className="rounded p-0.5 hover:text-fg"><Copy className="size-3.5" /></button>
                        </div>
                      </Td>
                      <Td><Badge mono>{k.quote}</Badge></Td>
                      <Td right mono>{rangeLabel}{rangeLabel !== 'Any' && <span className="text-muted"> SOL</span>}</Td>
                      <Td right mono>
                        {k.copyMode === 'proportional'
                          ? <>{k.copyPct ?? 100}% <span className="text-muted">prop</span></>
                          : <>{k.buySizeSol.toFixed(2)} <span className="text-muted">SOL</span></>}
                      </Td>
                      <Td right mono>{k.maxCurveReserveSol} <span className="text-muted">SOL</span></Td>
                      <Td right mono>
                        <Link href={`/?tab=closed&kol=${encodeURIComponent(k.id)}`} className="hover:text-accent hover:underline" title={`View ${k.label} trades on Overview`}>
                          {wr == null ? '—' : `${wr.toFixed(0)}%`} <span className="text-[0.8rem] text-muted">({k.stats.wins}/{n})</span>
                        </Link>
                      </Td>
                      <Td right mono className={tone(k.stats.realizedSol)}>{fmtSol(k.stats.realizedSol, 3, true)}</Td>
                      <Td right mono className="text-fg2">{k.stats.lastSeenSlot ? `#${fmtSlot(k.stats.lastSeenSlot)}` : '—'}</Td>
                      <Td right>
                        <div className="flex justify-end gap-1.5">
                          <Link href={`/?tab=closed&kol=${encodeURIComponent(k.id)}`} aria-label={`View ${k.label} trades`} title="View trades" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-fg2 hover:bg-raised hover:text-fg">
                            <ArrowUpRight className="size-4" />
                          </Link>
                          <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${k.label}`} onClick={() => setEdit(toDraft(k))} />
                          <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${k.label}`} onClick={() => setRemove(k)} className="hover:text-rose-300" />
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {edit !== undefined && <KolModal draft={edit} onClose={() => setEdit(undefined)} />}
      <Modal open={!!remove} onClose={() => setRemove(null)} title={`Remove ${remove?.label}?`}>
        <p className="text-sm text-fg2">The bot stops watching this wallet. Open positions from it stay open and keep their exits.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemove(null)}>Cancel</Button>
          <Button variant="danger" icon={Trash2} data-autofocus onClick={async () => { if (remove && await run({ type: 'kol.remove', id: remove.id }, `${remove.label} removed`)) setRemove(null); }}>Remove</Button>
        </div>
      </Modal>
    </>
  );
}

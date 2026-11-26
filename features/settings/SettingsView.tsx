'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, RefreshCw, TriangleAlert, Upload } from '@/components/icons';
import { Button, Modal, Skeleton, cx } from '@/components/ui';
import { useTerminal } from '@/lib/store';
import { fmtAgo } from '@/lib/format';
import {
  diffConfig, exportConfig, importConfig, validateConfig, type BotConfig, type ConfigChange, type FieldErrors, type SectionKey,
} from '@/lib/config/schema';
import type { ConfigApplyResult } from '@/lib/types';
import { FormProvider, setAt } from './form';
import { ExitsTab, LandersTab, NetworkTab, SecurityTab, StrategyTab, TreasuryTab, WalletsTab } from './tabs';

type SettingsTabKey = SectionKey | 'security';

const TABS: { key: SettingsTabKey; label: string; render: () => ReactNode }[] = [
  { key: 'network', label: 'Network & Ingestion', render: () => <NetworkTab /> },
  { key: 'wallets', label: 'Wallets & Nonce Pool', render: () => <WalletsTab /> },
  { key: 'strategy', label: 'Strategy & Buy Guards', render: () => <StrategyTab /> },
  { key: 'landers', label: 'Multi-Lander & Fees', render: () => <LandersTab /> },
  { key: 'exits', label: 'Exit Ladder & Risk', render: () => <ExitsTab /> },
  { key: 'treasury', label: 'Treasury Auto-Sweep', render: () => <TreasuryTab /> },
  { key: 'security', label: 'Security', render: () => <SecurityTab /> },
];
const LABEL = Object.fromEntries(TABS.map((t) => [t.key, t.label])) as Record<SettingsTabKey, string>;

const TabPanel = memo(function TabPanel({ tab }: { tab: SettingsTabKey }) {
  return <div role="tabpanel" aria-label={LABEL[tab]}>{TABS.find((t) => t.key === tab)!.render()}</div>;
});

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'number' && Number.isNaN(v) ? 'invalid' : typeof v === 'string' ? (v === '' ? '""' : v) : JSON.stringify(v));

function DiffList({ changes }: { changes: ConfigChange[] }) {
  const by = new Map<string, ConfigChange[]>();
  for (const c of changes) { const k = c.path.split('.')[0]; by.set(k, [...(by.get(k) ?? []), c]); }
  return (
    <div className="grid gap-4">
      {[...by].map(([section, cs]) => (
        <div key={section}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{LABEL[section as SectionKey] ?? section}</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {cs.map((c) => (
              <li key={c.path} className="grid gap-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <code className="num text-[0.78rem] text-fg">{c.path.split('.').slice(1).join('.')}</code>
                  {c.restart ? <span className="rounded-md bg-accent/15 px-1.5 py-px text-[0.65rem] font-semibold uppercase text-accent">Restart</span>
                    : <span className="rounded-md bg-emerald-400/12 px-1.5 py-px text-[0.65rem] font-semibold uppercase text-emerald-300">Live</span>}
                </div>
                <div className="num grid gap-0.5 break-all text-[0.75rem]">
                  <span className="text-rose-300/90">− {show(c.before)}</span>
                  <span className="text-emerald-300/90">+ {show(c.after)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const TAB_KEYS = new Set<SettingsTabKey>(TABS.map((t) => t.key));

export function SettingsView() {
  const { state, send, toast } = useTerminal();
  const cs = state.config;
  const [tab, setTab] = useState<SettingsTabKey>('network');
  const [draft, setDraft] = useState<BotConfig | null>(null);
  const [base, setBase] = useState<number | null>(null);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [importErr, setImportErr] = useState<{ error: string; errors?: FieldErrors } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Deep-link support: /settings#network|wallets|strategy|landers|exits|treasury|security
  useEffect(() => {
    const readHash = () => {
      const frag = decodeURIComponent(window.location.hash.replace(/^#/, '')) as SettingsTabKey;
      if (TAB_KEYS.has(frag)) setTab(frag);
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);

  const selectTab = useCallback((next: SettingsTabKey) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  // Follow the engine's config while there are no local edits.
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!cs) return;
    if (!draft || !dirtyRef.current) { setDraft(structuredClone(cs.config)); setBase(cs.version); }
  }, [cs?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(() => (cs && draft ? diffConfig(cs.config, draft) : []), [cs, draft]);
  dirtyRef.current = changes.length > 0;
  const errors = useMemo<FieldErrors>(() => {
    if (!draft) return {};
    const v = validateConfig(draft);
    return { ...(v.ok ? {} : v.errors), ...serverErrors };
  }, [draft, serverErrors]);
  const errCount = (k: SettingsTabKey) => Object.keys(errors).filter((p) => p === k || p.startsWith(k + '.')).length;
  const totalErrors = Object.keys(errors).length;
  const stale = cs && base != null && cs.version !== base && changes.length > 0;

  const set = useCallback((path: string, v: unknown) => {
    setServerErrors((e) => (e[path] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== path)) : e));
    setDraft((d) => (d ? setAt(d, path, v) : d));
  }, []);
  const formValue = useMemo(() => (draft ? { draft, set, errors, disabled: saving } : null), [draft, set, errors, saving]);

  if (!cs || !draft || !formValue) {
    return (
      <div className="mx-auto max-w-[96rem]" role="status" aria-label="Loading settings">
        <Skeleton className="h-9 w-48" /><Skeleton className="mt-3 h-4 w-72" />
        <Skeleton className="mt-8 h-11 w-full max-w-4xl rounded-xl" />
        <Skeleton className="mt-6 h-72 w-full rounded-[1.4rem]" />
      </div>
    );
  }

  const discard = () => { setDraft(structuredClone(cs.config)); setBase(cs.version); setServerErrors({}); setConflict(null); };

  const save = async () => {
    setSaving(true);
    try {
      const r = await send<ConfigApplyResult>({ type: 'config.update', baseVersion: base ?? cs.version, config: draft });
      setBase(r.version); setReview(false); setServerErrors({}); dirtyRef.current = false;
      toast(`Saved v${r.version} · ${r.appliedLive.length} applied live${r.pendingRestart.length ? ` · ${r.pendingRestart.length} after restart` : ''}`, 'ok');
    } catch (e) {
      const err = e as Error & { fields?: FieldErrors };
      if (err.fields) { setServerErrors(err.fields); setReview(false); toast('The engine rejected some values', 'error'); }
      else if (/changed since/.test(err.message)) { setConflict(err.message); setReview(false); }
      else toast(err.message, 'error');
    } finally { setSaving(false); }
  };

  const doExport = () => {
    const url = URL.createObjectURL(new Blob([exportConfig(cs.config)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `odex-config-v${cs.version}.json` }).click();
    URL.revokeObjectURL(url);
    toast('Exported saved config (secrets stripped)', 'ok');
  };
  const doImport = async (file: File) => {
    const r = importConfig(await file.text());
    if (!r.ok) { setImportErr(r); return; }
    setDraft(r.config);
    toast(`Imported ${file.name} as unsaved changes${r.stripped.length ? ` · ${r.stripped.length} secret value(s) ignored` : ''}`, r.stripped.length ? 'info' : 'ok');
  };

  const restartCount = changes.filter((c) => c.restart).length;

  return (
    <FormProvider value={formValue}>
      <div className="mx-auto max-w-[96rem] pb-24">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[2.25rem] font-bold leading-tight tracking-tight">Settings</h1>
            <p className="mt-1 text-[0.95rem] text-fg2">Engine config v{cs.version} · saved {fmtAgo(cs.updatedAt)} ago · changes apply live unless marked <span className="font-medium text-accent">Restart</span></p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
            <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center gap-1.5 rounded-[0.68rem] border border-line bg-card px-3.5 text-[0.855rem] font-medium hover:bg-raised"><Upload className="size-3.5" aria-hidden />Import JSON</button>
            <button type="button" onClick={doExport} className="inline-flex h-9 items-center gap-1.5 rounded-[0.68rem] border border-line bg-card px-3.5 text-[0.855rem] font-medium hover:bg-raised"><Download className="size-3.5" aria-hidden />Export JSON</button>
          </div>
        </div>

        {cs.pendingRestart.length > 0 && (
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-fg">
            <RefreshCw className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <div><b className="font-semibold text-accent">Restart needed.</b> {cs.pendingRestart.length} saved change{cs.pendingRestart.length > 1 ? 's' : ''} take effect after the engine restarts: <span className="num text-[0.8rem]">{cs.pendingRestart.join(', ')}</span></div>
          </div>
        )}
        {(stale || conflict) && (
          <div role="alert" className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-rose-400/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{conflict ?? `The engine config changed to v${cs.version} while you were editing v${base}.`} Saving now would overwrite it.</span>
            <Button size="sm" onClick={discard}>Discard my edits and load v{cs.version}</Button>
          </div>
        )}

        <div role="tablist" aria-label="Settings sections" className="mb-6 flex max-w-full gap-1 overflow-x-auto rounded-[0.9rem] border border-line bg-panel p-1">
          {TABS.map((t) => {
            const n = errCount(t.key), dirty = changes.some((c) => c.path.startsWith(t.key + '.'));
            return (
              <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => selectTab(t.key)}
                className={cx('inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-[0.65rem] px-3.5 py-2 text-[0.9rem] font-medium', tab === t.key ? 'bg-raised text-fg' : 'text-fg2 hover:text-fg')}>
                {t.label}
                {n > 0 ? <span className="rounded-full bg-rose-400/15 px-1.5 text-[0.7rem] font-semibold text-rose-300" aria-label={`${n} errors`}>{n}</span>
                  : dirty ? <span className="size-1.5 rounded-full bg-accent" aria-label="unsaved changes" /> : null}
              </button>
            );
          })}
        </div>

        <TabPanel tab={tab} />
      </div>

      {/* save bar */}
      {changes.length > 0 && (
        <div className="sticky bottom-[6.25rem] z-20 mx-auto max-w-[96rem] md:bottom-12">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line2 bg-raised/95 px-4 py-3 shadow-2xl backdrop-blur">
            <span className="text-sm"><b className="font-semibold">{changes.length}</b> unsaved change{changes.length > 1 ? 's' : ''}
              {restartCount > 0 && <span className="text-accent"> · {restartCount} need restart</span>}
              {totalErrors > 0 && (
                <button
                  type="button"
                  onClick={() => { const first = TABS.find((t) => errCount(t.key) > 0); if (first) selectTab(first.key); }}
                  className="text-rose-300 underline decoration-rose-400/50 underline-offset-2 hover:text-rose-200"
                >
                  {' '}· {totalErrors} error{totalErrors > 1 ? 's' : ''} to fix
                </button>
              )}
            </span>
            <div className="ml-auto flex gap-2">
              <Button onClick={discard} disabled={saving}>Discard</Button>
              <Button variant="primary" onClick={() => setReview(true)} disabled={totalErrors > 0 || !!stale || !!conflict}>Review & save</Button>
            </div>
          </div>
        </div>
      )}

      <Modal open={review} onClose={() => setReview(false)} title={`Review ${changes.length} change${changes.length > 1 ? 's' : ''}`}>
        <p className="mb-4 text-sm text-fg2">Saving to config v{cs.version}. <span className="text-fg font-medium">Live</span> changes apply on the next detection. <span className="font-medium text-accent">Restart</span> changes are saved now and apply after an engine restart.</p>
        <div className="max-h-[55vh] overflow-auto pr-1"><DiffList changes={changes} /></div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setReview(false)}>Back</Button>
          <Button variant="primary" loading={saving} onClick={save} data-autofocus>Save v{cs.version + 1}</Button>
        </div>
      </Modal>

      <Modal open={!!importErr} onClose={() => setImportErr(null)} title="Import failed">
        <p className="text-sm text-fg2">{importErr?.error} Nothing was changed.</p>
        {importErr?.errors && (
          <ul className="mt-3 max-h-64 space-y-1 overflow-auto rounded-xl border border-line p-3 text-sm">
            {Object.entries(importErr.errors).slice(0, 12).map(([k, m]) => <li key={k}><code className="num text-[0.78rem] text-fg">{k}</code> <span className="text-rose-300">{m}</span></li>)}
          </ul>
        )}
        <div className="mt-5 flex justify-end"><Button onClick={() => setImportErr(null)}>Close</Button></div>
      </Modal>
    </FormProvider>
  );
}

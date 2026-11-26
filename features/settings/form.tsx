'use client';

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { RefreshCw } from '@/components/icons';
import { Toggle, cx } from '@/components/ui';
import { needsRestart, type BotConfig, type FieldErrors } from '@/lib/config/schema';

// ---------- path helpers (dotted, with [n] for arrays) ----------
const split = (path: string) => path.replace(/\[(\d+)\]/g, '.$1').split('.');
export function getAt(obj: unknown, path: string): unknown {
  return split(path).reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const keys = split(path);
  const rec = (o: unknown, i: number): unknown => {
    const k = keys[i];
    const base = Array.isArray(o) ? [...o] : { ...(o as object) };
    (base as Record<string, unknown>)[k] = i === keys.length - 1 ? value : rec((o as Record<string, unknown>)?.[k], i + 1);
    return base;
  };
  return rec(obj, 0) as T;
}

// ---------- form context ----------
interface FormCtx { draft: BotConfig; set: (path: string, v: unknown) => void; errors: FieldErrors; disabled: boolean }
const Ctx = createContext<FormCtx | null>(null);
export const FormProvider = ({ value, children }: { value: FormCtx; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useForm() { const c = useContext(Ctx); if (!c) throw new Error('useForm outside FormProvider'); return c; }
function useField<T>(path: string) {
  const f = useForm();
  return { value: getAt(f.draft, path) as T, set: (v: T) => f.set(path, v), error: f.errors[path], disabled: f.disabled };
}

// ---------- layout ----------
export function Section({ title, desc, children, error, actions }: { title: string; desc?: ReactNode; children: ReactNode; error?: string; actions?: ReactNode }) {
  return (
    <section className="relative overflow-hidden rounded-[1.4rem] border border-line2 bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 pb-4 pt-5">
        <div>
          <h2 className="text-[1.1rem] font-semibold tracking-tight">{title}</h2>
          {desc && <p className="mt-1 max-w-3xl text-sm text-fg2">{desc}</p>}
        </div>
        {actions}
      </header>
      {error && <p role="alert" className="mx-6 mt-4 rounded-lg border border-rose-400/35 bg-rose-400/10 px-3 py-2 text-sm text-rose-200">{error}</p>}
      <div className="grid gap-x-5 gap-y-5 p-6 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

export function RestartTag({ path }: { path: string }) {
  if (!needsRestart(path)) return null;
  return <span title="Saved immediately, takes effect after the engine restarts" className="inline-flex items-center gap-1 text-[0.68rem] font-medium uppercase tracking-wide text-accent"><RefreshCw className="size-2.5 text-accent" aria-hidden />Restart</span>;
}

function Shell({ id, label, path, hint, error, children, wide }: { id: string; label: string; path: string; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2 xl:col-span-3')}>
      <label htmlFor={id} className="flex items-center gap-2 text-[0.8rem] font-medium text-fg2">{label}<RestartTag path={path} /></label>
      {children}
      {error ? <p id={`${id}-err`} role="alert" className="text-xs text-rose-300">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

const inputCls = (err?: string) => cx('h-9 w-full min-w-0 rounded-[0.65rem] border bg-card px-3 text-sm outline-none placeholder:text-muted focus:border-accent disabled:opacity-60', err ? 'border-rose-400' : 'border-line2');

// ---------- fields ----------
export function NumField({ path, label, unit, hint, nullable, prefix }: { path: string; label: string; unit?: string; hint?: ReactNode; nullable?: boolean; prefix?: string }) {
  const { value, set, error, disabled } = useField<number | null>(path);
  const id = useId();
  const [text, setText] = useState(value == null ? '' : String(value));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(value == null ? '' : String(value)); }, [value, focus]);
  const commit = (t: string) => {
    setText(t);
    if (t.trim() === '') { set(nullable ? null : (NaN as unknown as number)); return; }
    const n = Number(t.replace(/[_,\s]/g, ''));
    set(Number.isFinite(n) ? n : (NaN as unknown as number));
  };
  return (
    <Shell id={id} label={label} path={path} hint={hint ?? (nullable ? 'Leave empty to turn off.' : undefined)} error={error}>
      <div className="relative">
        {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">{prefix}</span>}
        <input id={id} inputMode="decimal" className={cx(inputCls(error), 'num', prefix && 'pl-6', unit && 'pr-16')} value={text} disabled={disabled}
          aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-err` : undefined}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => commit(e.target.value)} placeholder={nullable ? 'Off' : undefined} />
        {unit && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">{unit}</span>}
      </div>
    </Shell>
  );
}

export function TextField({ path, label, hint, placeholder, mono, wide }: { path: string; label: string; hint?: ReactNode; placeholder?: string; mono?: boolean; wide?: boolean }) {
  const { value, set, error, disabled } = useField<string>(path);
  const id = useId();
  return (
    <Shell id={id} label={label} path={path} hint={hint} error={error} wide={wide}>
      <input id={id} className={cx(inputCls(error), mono && 'num text-[0.8rem]')} value={value ?? ''} placeholder={placeholder} disabled={disabled}
        spellCheck={false} autoComplete="off" aria-invalid={!!error || undefined} onChange={(e) => set(e.target.value)} />
    </Shell>
  );
}

export function SelectField({ path, label, options, hint }: { path: string; label: string; options: { value: string; label: string }[]; hint?: ReactNode }) {
  const { value, set, error, disabled } = useField<string>(path);
  const id = useId();
  return (
    <Shell id={id} label={label} path={path} hint={hint} error={error}>
      <select id={id} className={inputCls(error)} value={value} disabled={disabled} onChange={(e) => set(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

export function ToggleField({ path, label, desc }: { path: string; label: string; desc?: ReactNode }) {
  const { value, set, disabled } = useField<boolean>(path);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line bg-card px-4 py-3">
      <Toggle checked={!!value} onChange={set} label={label} disabled={disabled} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">{label}<RestartTag path={path} /></div>
        {desc && <div className="mt-0.5 text-xs text-muted">{desc}</div>}
      </div>
    </div>
  );
}

/** One public key / URL per line. */
export function ListField({ path, label, hint, placeholder, rows = 4 }: { path: string; label: string; hint?: ReactNode; placeholder?: string; rows?: number }) {
  const f = useForm();
  const value = (getAt(f.draft, path) as string[]) ?? [];
  const id = useId();
  const [text, setText] = useState(value.join('\n'));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(value.join('\n')); }, [value.join('\n'), focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const itemErrors = Object.entries(f.errors).filter(([k]) => k.startsWith(`${path}[`)).map(([k, m]) => `Line ${Number(k.slice(path.length + 1, -1)) + 1 || '?'}: ${m}`);
  const error = f.errors[path] ?? itemErrors[0];
  return (
    <Shell id={id} label={`${label} (${value.length})`} path={path} hint={hint} error={error} wide>
      <textarea id={id} rows={rows} className={cx(inputCls(error), 'num h-auto py-2 text-[0.8rem] leading-relaxed')} value={text} placeholder={placeholder}
        disabled={f.disabled} spellCheck={false} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        onChange={(e) => { setText(e.target.value); f.set(path, e.target.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)); }} />
    </Shell>
  );
}

export function SlotRangeField({ path, label, hint }: { path: string; label: string; hint?: ReactNode }) {
  const f = useForm();
  const err = f.errors[`${path}.min`] ?? f.errors[`${path}.max`] ?? f.errors[path];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[0.8rem] font-medium text-fg2">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <NumInline path={`${path}.min`} label={`${label} minimum`} prefix="+" />
        <NumInline path={`${path}.max`} label={`${label} maximum`} prefix="+" />
      </div>
      {err ? <p role="alert" className="text-xs text-rose-300">{err}</p> : hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function NumInline({ path, label, prefix }: { path: string; label: string; prefix?: string }) {
  const { value, set, error, disabled } = useField<number>(path);
  const [text, setText] = useState(String(value ?? ''));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(String(value ?? '')); }, [value, focus]);
  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">{prefix}</span>}
      <input aria-label={label} inputMode="numeric" className={cx(inputCls(error), 'num pl-6 pr-12')} value={text} disabled={disabled}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        onChange={(e) => { setText(e.target.value); const n = Number(e.target.value); set(e.target.value.trim() === '' || !Number.isFinite(n) ? (NaN as unknown as number) : n); }} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">slots</span>
    </div>
  );
}

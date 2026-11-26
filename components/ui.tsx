'use client';

import clsx from 'clsx';
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { LoaderCircle, X, type LucideIcon } from '@/components/icons';

export { clsx as cx };

// ---------- surfaces ----------
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return <section className={clsx('relative rounded-(--radius-card) border border-line2 bg-panel overflow-hidden', className)} {...rest}>{children}</section>;
}

export function CardHeader({ title, meta, actions, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={clsx('flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-3.5', className)}>
      <div className="min-w-0">
        <h2 className="text-[0.95rem] font-semibold tracking-tight">{title}</h2>
        {meta && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[1.75rem] font-bold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-fg2">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ---------- badges ----------
type Tone = 'neutral' | 'ok' | 'bad' | 'warn' | 'accent' | 'info';
const toneCls: Record<Tone, string> = {
  neutral: 'border-line2 bg-raised text-fg2',
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  bad: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  warn: 'border-amber-400/35 bg-amber-400/10 text-amber-300',
  accent: 'border-accent/40 bg-accent/15 text-accent',
  info: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
};
export function Badge({ tone = 'neutral', children, className, mono }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[0.7rem] font-semibold', mono && 'num', toneCls[tone], className)}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const c = { neutral: 'bg-muted', ok: 'bg-emerald-400', bad: 'bg-rose-400', warn: 'bg-amber-400', accent: 'bg-accent', info: 'bg-sky-400' }[tone];
  return <span aria-hidden className={clsx('inline-block size-1.5 shrink-0 rounded-full', c)} />;
}

// ---------- buttons ----------
type BtnVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'dangerSolid';
const btnCls: Record<BtnVariant, string> = {
  default: 'border-line bg-card text-fg hover:bg-raised',
  primary: 'border-accent bg-accent text-[#09090d] font-semibold hover:bg-accent/90',
  danger: 'border-rose-400/35 bg-rose-400/10 text-rose-300 hover:bg-rose-400/20',
  dangerSolid: 'border-rose-500 bg-rose-600 text-white hover:bg-rose-500',
  ghost: 'border-transparent bg-transparent text-fg2 hover:bg-raised hover:text-fg',
};
export function Button({ variant = 'default', size = 'md', icon: Icon, loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[0.6rem] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8.5 px-3.5 text-sm',
        btnCls[variant], className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : Icon && <Icon className="size-3.5" aria-hidden />}
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-45', checked ? 'bg-accent' : 'bg-line2')}
    >
      <span className={clsx('absolute top-0.5 size-4 rounded-full bg-white transition-[left]', checked ? 'left-[1.15rem]' : 'left-0.5')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex gap-0.5 rounded-xl border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={clsx('h-7 rounded-[0.55rem] px-2.5 text-xs font-medium transition-colors', value === o.value ? 'bg-raised text-fg' : 'text-fg2 hover:text-fg')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- form ----------
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-fg2">{label}</label>
      {children}
      {error ? <p className="text-xs text-rose-300" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={clsx('h-8.5 w-full min-w-0 rounded-[0.6rem] border bg-card px-3 text-sm outline-none placeholder:text-muted focus:border-accent disabled:opacity-60', invalid ? 'border-rose-400' : 'border-line2', className)} aria-invalid={invalid || undefined} {...rest} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx('h-8.5 w-full rounded-[0.6rem] border border-line2 bg-card px-2.5 text-sm outline-none focus:border-accent disabled:opacity-60', className)} {...rest}>{children}</select>;
}

// ---------- states ----------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded-md bg-raised', className)} />;
}
export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {Icon && <Icon className="mb-3 size-6 text-muted" aria-hidden />}
      <p className="font-semibold">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm text-fg2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-line" aria-label="Loading" role="status">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-5 py-3.5">{Array.from({ length: cols }).map((__, j) => <Skeleton key={j} className="h-4 flex-1" />)}</div>
      ))}
    </div>
  );
}

// ---------- table ----------
export function Th({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <th scope="col" className={clsx('whitespace-nowrap border-b border-line px-3 py-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted first:pl-5 last:pr-5', right ? 'text-right' : 'text-left', className)}>{children}</th>;
}
export function Td({ children, right, className, mono }: { children?: ReactNode; right?: boolean; className?: string; mono?: boolean }) {
  return <td className={clsx('border-b border-line px-3 py-2.5 align-middle first:pl-5 last:pr-5', right && 'text-right', mono && 'num', className)}>{children}</td>;
}

// ---------- modal ----------
export function Modal({ open, onClose, title, children, labelledBy, tone = 'neutral' }:
  { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; labelledBy?: string; tone?: 'neutral' | 'danger' }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('input, select, button'))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && el) {
        const f = el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])');
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  // Portal to <body>: ancestors with backdrop-filter would otherwise trap position:fixed.
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? id}
        className={clsx('max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-auto rounded-2xl border bg-panel p-5 shadow-2xl', tone === 'danger' ? 'border-rose-500/50' : 'border-line2')}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id={labelledBy ?? id} className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

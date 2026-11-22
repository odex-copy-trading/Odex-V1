const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

const sign = (v: number, show: boolean) => (v < 0 ? '−' : show && v > 0 ? '+' : '');

export const fmtUsd = (v: number, showSign = false) => (Number.isFinite(v) ? `${sign(v, showSign)}$${usd2.format(Math.abs(v))}` : '—');
export const fmtSol = (v: number, digits = 4, showSign = false) => (Number.isFinite(v) ? `${sign(v, showSign)}${Math.abs(v).toFixed(digits)}` : '—');
export const fmtPct = (v: number, digits = 1, showSign = true) => (Number.isFinite(v) ? `${sign(v, showSign)}${Math.abs(v).toFixed(digits)}%` : '—');
export const fmtInt = (v: number) => (Number.isFinite(v) ? int.format(v) : '—');
export const fmtCompact = (v: number) => (Number.isFinite(v) ? compact.format(v) : '—');
export const fmtSlot = (v: number) => (Number.isFinite(v) && v > 0 ? int.format(v) : '—');
export const shortKey = (k: string, n = 4) => (k.length > n * 2 + 1 ? `${k.slice(0, n)}…${k.slice(-n)}` : k);

export function fmtAgo(ts: number, now = Date.now()) {
  if (!ts || !Number.isFinite(ts)) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const tone = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-fg2');

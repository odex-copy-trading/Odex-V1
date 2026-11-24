'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, Trophy, Upload, X } from '@/components/icons';
import { cx } from '@/components/ui';
import { fmtSol, fmtUsd } from '@/lib/format';
import type { ClosedPosition, Position } from '@/lib/types';

export type DatePreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'quarter' | 'all' | 'custom';

export interface DateRangeValue {
  preset: DatePreset;
  start: number;
  end: number;
  label: string;
}

const PRESETS: { key: DatePreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'all', label: 'All time' },
];

function startOfDay(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return x.getTime();
}
function endOfDay(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return x.getTime();
}

export function rangeForPreset(preset: DatePreset): DateRangeValue {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  switch (preset) {
    case 'today':
      return { preset, start: todayStart, end: todayEnd, label: 'Today' };
    case 'yesterday': {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { preset, start: startOfDay(y), end: endOfDay(y), label: 'Yesterday' };
    }
    case '7d': {
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
      return { preset, start: startOfDay(s), end: todayEnd, label: 'Last 7 days' };
    }
    case '30d': {
      const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
      return { preset, start: startOfDay(s), end: todayEnd, label: 'Last 30 days' };
    }
    case 'month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return { preset, start: startOfDay(s), end: todayEnd, label: 'This month' };
    }
    case 'quarter': {
      const qm = Math.floor(now.getMonth() / 3) * 3;
      const s = new Date(now.getFullYear(), qm, 1);
      return { preset, start: startOfDay(s), end: todayEnd, label: 'This quarter' };
    }
    case 'all':
    default:
      return { preset: 'all', start: 0, end: todayEnd + 86_400_000, label: 'All time' };
  }
}

function fmtShortDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildMonthGridSun(year: number, month: number): { date: Date; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const offset = first.getDay(); // 0=Sun
  const start = new Date(year, month, 1 - offset);
  const cells: { date: Date; inMonth: boolean }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: d, inMonth: d.getMonth() === month });
  }
  // Drop trailing 6th row if completely outside month
  if (cells.slice(35).every((c) => !c.inMonth)) return cells.slice(0, 35);
  return cells;
}

function MonthCalendar({
  year,
  month,
  selStart,
  selEnd,
  onSelectDay,
  leftArrow,
  rightArrow,
}: {
  year: number;
  month: number;
  selStart: number;
  selEnd: number;
  onSelectDay: (d: Date) => void;
  leftArrow?: () => void;
  rightArrow?: () => void;
}) {
  const title = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const cells = useMemo(() => buildMonthGridSun(year, month), [year, month]);

  return (
    <div className="w-full min-w-0">
      <div className="mb-3 flex items-center justify-between">
        {leftArrow ? (
          <button type="button" onClick={leftArrow} aria-label="Previous month" className="grid size-7 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-fg2 hover:bg-white/[0.1] hover:text-fg">
            <ChevronLeft className="size-3.5" />
          </button>
        ) : <span className="size-7" />}
        <span className="text-sm font-semibold text-fg">{title}</span>
        {rightArrow ? (
          <button type="button" onClick={rightArrow} aria-label="Next month" className="grid size-7 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-fg2 hover:bg-white/[0.1] hover:text-fg">
            <ChevronRight className="size-3.5" />
          </button>
        ) : <span className="size-7" />}
      </div>
      <div className="mb-1.5 grid grid-cols-7 text-center text-[0.7rem] font-medium text-muted">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => <span key={d} className="py-1">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-xs tabular-nums">
        {cells.map(({ date, inMonth }) => {
          const ds = startOfDay(date);
          const de = endOfDay(date);
          const isStart = selStart > 0 && ds === startOfDay(new Date(selStart));
          const isEnd = selEnd > 0 && ds === startOfDay(new Date(selEnd));
          const inRange = selStart > 0 && ds >= selStart && de <= selEnd;
          const active = isStart || isEnd;
          return (
            <button
              key={ds}
              type="button"
              onClick={() => onSelectDay(date)}
              className={cx(
                'mx-auto grid size-8 place-items-center rounded-lg transition-colors',
                active
                  ? 'bg-white font-bold text-black shadow-sm'
                  : inRange && inMonth
                    ? 'bg-white/12 font-medium text-fg'
                    : inMonth
                      ? 'text-fg hover:bg-white/[0.08]'
                      : 'text-muted/40 hover:bg-white/[0.04]',
              )}
            >
              {date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRangeValue>(value);
  const [pickAnchor, setPickAnchor] = useState<number | null>(null);
  const now = new Date();
  const [rightMonth, setRightMonth] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(value);
    setPickAnchor(null);
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, value]);

  const leftMonth = rightMonth.m === 0 ? { y: rightMonth.y - 1, m: 11 } : { y: rightMonth.y, m: rightMonth.m - 1 };
  const prevMonth = () => setRightMonth((r) => (r.m === 0 ? { y: r.y - 1, m: 11 } : { y: r.y, m: r.m - 1 }));
  const nextMonth = () => setRightMonth((r) => (r.m === 11 ? { y: r.y + 1, m: 0 } : { y: r.y, m: r.m + 1 }));

  const onSelectDay = (d: Date) => {
    const s = startOfDay(d);
    const e = endOfDay(d);
    if (pickAnchor == null) {
      setPickAnchor(s);
      setDraft({ preset: 'custom', start: s, end: e, label: fmtShortDate(s) });
    } else {
      const a = Math.min(pickAnchor, s);
      const b = endOfDay(new Date(Math.max(pickAnchor, s)));
      setPickAnchor(null);
      setDraft({
        preset: 'custom',
        start: a,
        end: b,
        label: a === startOfDay(new Date(b)) ? fmtShortDate(a) : `${fmtShortDate(a)} – ${fmtShortDate(b)}`,
      });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-1.5 rounded-[0.68rem] border border-line bg-card px-3 text-[0.84rem] font-medium hover:bg-raised"
      >
        <Calendar className="size-3.5 text-fg2" aria-hidden />
        <span>{value.label}</span>
        <ChevronDown className="size-3 text-muted" aria-hidden />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Select date range"
          className="absolute right-0 top-12 z-50 w-[min(48rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-white/10 bg-[#0d0e14] shadow-2xl"
        >
          <div className="flex flex-col sm:flex-row">
            {/* Presets sidebar */}
            <div className="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-white/[0.08] p-3 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setPickAnchor(null); setDraft(rangeForPreset(p.key)); }}
                  className={cx(
                    'whitespace-nowrap rounded-xl px-3 py-2 text-left text-xs font-medium transition-colors',
                    draft.preset === p.key ? 'bg-white/[0.1] text-white' : 'text-fg2 hover:bg-white/[0.05] hover:text-fg',
                  )}
                >
                  {p.label}
                </button>
              ))}
              <div className="my-1 hidden h-px bg-white/[0.08] sm:block" />
              <span className={cx('whitespace-nowrap rounded-xl px-3 py-2 text-xs font-medium', draft.preset === 'custom' ? 'bg-white/[0.1] text-white' : 'text-muted')}>
                Custom range
              </span>
            </div>

            {/* Dual-month calendar */}
            <div className="grid flex-1 grid-cols-1 gap-6 p-5 sm:grid-cols-2">
              <MonthCalendar
                year={leftMonth.y}
                month={leftMonth.m}
                selStart={draft.start}
                selEnd={draft.end}
                onSelectDay={onSelectDay}
                leftArrow={prevMonth}
              />
              <MonthCalendar
                year={rightMonth.y}
                month={rightMonth.m}
                selStart={draft.start}
                selEnd={draft.end}
                onSelectDay={onSelectDay}
                rightArrow={nextMonth}
              />
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-white/[0.08] px-4 py-3">
            <span className="text-xs text-muted">{draft.label}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-8.5 rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-fg hover:bg-white/[0.1]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { onChange(draft); setOpen(false); }}
                className="h-8.5 rounded-full bg-white px-4 text-xs font-semibold text-black hover:bg-zinc-200"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- PnL Calendar Modal ----------
export function PnlCalendarButton({
  closed,
  positions = [],
  solUsd = 0,
  defaultPaper,
}: {
  closed: ClosedPosition[];
  positions?: Position[];
  solUsd?: number;
  defaultPaper: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'paper' | 'real'>(defaultPaper ? 'paper' : 'real');
  const [unit, setUnit] = useState<'USD' | 'SOL'>('USD');
  const [highlightBest, setHighlightBest] = useState(true);
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() });

  useEffect(() => {
    if (open) setMode(defaultPaper ? 'paper' : 'real');
  }, [open, defaultPaper]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const monthTitle = new Date(ym.y, ym.m, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const prev = () => setYm((x) => (x.m === 0 ? { y: x.y - 1, m: 11 } : { y: x.y, m: x.m - 1 }));
  const next = () => setYm((x) => (x.m === 11 ? { y: x.y + 1, m: 0 } : { y: x.y, m: x.m + 1 }));

  const filtered = useMemo(
    () =>
      closed.filter((c) => {
        const isPaper = c.id.startsWith('cl_paper_');
        if (mode === 'paper' ? !isPaper : isPaper) return false;
        const d = new Date(c.closedAt);
        return d.getFullYear() === ym.y && d.getMonth() === ym.m;
      }),
    [closed, mode, ym],
  );

  // Aggregate daily PnL
  const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
  const firstDowMon = (new Date(ym.y, ym.m, 1).getDay() + 6) % 7; // 0=Mon..6=Sun

  const daily = useMemo(() => {
    const map = new Map<number, { sol: number; usd: number; count: number }>();
    for (const c of filtered) {
      const day = new Date(c.closedAt).getDate();
      const netSol = c.proceedsSol - c.entrySol;
      const netUsd = netSol * (c.solUsd || solUsd);
      const cur = map.get(day) ?? { sol: 0, usd: 0, count: 0 };
      cur.sol += netSol;
      cur.usd += netUsd;
      cur.count += 1;
      map.set(day, cur);
    }
    // Fold live open positions into today's cell so the calendar stays 100% live and matches Overview Period PnL
    const isCurrentMonth = now.getFullYear() === ym.y && now.getMonth() === ym.m;
    if (isCurrentMonth && positions.length > 0) {
      const today = now.getDate();
      for (const p of positions) {
        const isPaper = p.id.startsWith('paper_');
        if (mode === 'paper' ? !isPaper : isPaper) continue;
        const netSol = p.tokens * p.price + (p.proceedsSol ?? 0) - p.entrySol;
        const netUsd = netSol * solUsd;
        const cur = map.get(today) ?? { sol: 0, usd: 0, count: 0 };
        cur.sol += netSol;
        cur.usd += netUsd;
        cur.count += 1;
        map.set(today, cur);
      }
    }
    return map;
  }, [filtered, positions, mode, solUsd, ym, now]);

  let winDays = 0, loseDays = 0, winSum = 0, loseSum = 0, monthTotal = 0;
  let bestDay: number | null = null;
  let bestVal = 0;
  for (const [day, v] of daily.entries()) {
    const val = unit === 'USD' ? v.usd : v.sol;
    monthTotal += val;
    if (val > 0) {
      winDays++;
      winSum += val;
      if (val > bestVal) { bestVal = val; bestDay = day; }
    } else if (val < 0) {
      loseDays++;
      loseSum += val;
    }
  }
  const winRatio = winDays + loseDays > 0 ? (winDays / (winDays + loseDays)) * 100 : 0;
  const fmtVal = (v: number, sign = false) =>
    unit === 'USD' ? fmtUsd(v, sign) : `${fmtSol(v, 3, sign)} SOL`;

  const exportMonth = () => {
    const rows = [['day', 'trades', 'pnl_sol', 'pnl_usd']];
    for (let d = 1; d <= daysInMonth; d++) {
      const v = daily.get(d);
      if (v) rows.push([`${ym.y}-${String(ym.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, String(v.count), v.sol.toFixed(4), v.usd.toFixed(2)]);
    }
    const url = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: `whal-pnl-${ym.y}-${ym.m + 1}-${mode}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-[0.68rem] border border-line bg-card px-3 text-[0.84rem] font-medium hover:bg-raised"
      >
        <Calendar className="size-3.5 text-fg2" aria-hidden />
        <span>PnL calendar</span>
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-xs" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="PnL Calendar"
            style={{ fontFamily: 'var(--font-geist), Inter, system-ui, sans-serif' }}
            className="max-h-[94vh] w-full max-w-[62rem] overflow-auto rounded-2xl border border-white/10 bg-[#0b0c12] p-7 shadow-2xl"
          >
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-[1.15rem] font-bold text-white">PnL Calendar (Solana)</h2>
                <div role="group" aria-label="Mode" className="inline-flex rounded-full border border-white/10 bg-white/[0.04] p-0.5 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setMode('paper')}
                    className={cx('rounded-full px-3 py-1 transition-colors', mode === 'paper' ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-400/40' : 'text-muted hover:text-fg')}
                  >
                    Paper
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('real')}
                    className={cx('rounded-full px-3 py-1 transition-colors', mode === 'real' ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40' : 'text-muted hover:text-fg')}
                  >
                    Real SOL
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <button type="button" onClick={prev} aria-label="Previous month" className="rounded-lg p-1 text-fg2 hover:bg-white/[0.08] hover:text-fg"><ChevronLeft className="size-4" /></button>
                  <span className="min-w-[5.2rem] text-center">{monthTitle}</span>
                  <button type="button" onClick={next} aria-label="Next month" className="rounded-lg p-1 text-fg2 hover:bg-white/[0.08] hover:text-fg"><ChevronRight className="size-4" /></button>
                </div>
                <button
                  type="button"
                  onClick={() => setUnit((u) => (u === 'USD' ? 'SOL' : 'USD'))}
                  className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs font-semibold text-fg hover:bg-white/[0.1]"
                >
                  {unit}
                </button>
                <button
                  type="button"
                  onClick={() => setHighlightBest((h) => !h)}
                  aria-pressed={highlightBest}
                  title={bestDay ? `Best performing day: ${monthTitle.split(' ')[0]} ${bestDay} (${fmtVal(bestVal, true)})` : 'Highlight best performing day'}
                  className={cx(
                    'grid size-7 place-items-center rounded-lg transition-colors',
                    highlightBest ? 'bg-amber-400/15 text-amber-400 ring-1 ring-amber-400/40' : 'text-amber-400/50 hover:bg-white/[0.08] hover:text-amber-300',
                  )}
                >
                  <Trophy className="size-4" />
                </button>
                <button type="button" onClick={exportMonth} title="Export month CSV" className="grid size-7 place-items-center rounded-lg text-fg2 hover:bg-white/[0.08] hover:text-fg">
                  <Upload className="size-4" />
                </button>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="grid size-7 place-items-center rounded-lg text-fg2 hover:bg-white/[0.08] hover:text-fg">
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* Monthly total + win/loss bar */}
            <div className="mt-5 text-center text-base text-fg2">
              Total PnL for the month:{' '}
              <b className={cx('text-[1.32rem] font-semibold tracking-tight tabular-nums', monthTotal > 0 ? 'text-emerald-400' : monthTotal < 0 ? 'text-rose-400' : 'text-white')}>
                {fmtVal(monthTotal, monthTotal !== 0)}
              </b>
            </div>
            <div className="mt-3.5 flex items-center justify-between text-[0.9rem] font-medium tabular-nums">
              <span className="text-emerald-400">{winDays} / {fmtVal(winSum)}</span>
              <span className="text-rose-400">{loseDays} / {fmtVal(loseSum)}</span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
              {winDays + loseDays > 0 && (
                <div className="flex h-full w-full">
                  <div className="bg-emerald-400" style={{ width: `${winRatio}%` }} />
                  <div className="bg-rose-400" style={{ width: `${100 - winRatio}%` }} />
                </div>
              )}
            </div>

            {/* Calendar grid (MON..SUN) */}
            <div className="mt-6 grid grid-cols-7 gap-1 text-center text-[0.76rem] font-medium uppercase tracking-wider text-muted">
              {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => <div key={d} className="pb-1.5">{d}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDowMon }).map((_, i) => <div key={`pad-${i}`} className="h-[5.75rem]" />)}
              {Array.from({ length: daysInMonth }).map((_, idx) => {
                const day = idx + 1;
                const info = daily.get(day);
                const val = info ? (unit === 'USD' ? info.usd : info.sol) : 0;
                const isToday = now.getFullYear() === ym.y && now.getMonth() === ym.m && now.getDate() === day;
                const isBest = highlightBest && bestDay === day && val > 0;
                return (
                  <div
                    key={day}
                    title={info ? `${info.count} trade${info.count === 1 ? '' : 's'}${isBest ? ' · Best day of month' : ''}` : 'No trades'}
                    className={cx(
                      'relative flex h-[5.75rem] flex-col rounded-[3px] px-2.5 py-2 transition-colors',
                      isBest
                        ? 'bg-[#3d3110] ring-1 ring-inset ring-amber-400/75'
                        : val > 0
                          ? 'bg-[#15392a]'
                          : val < 0
                            ? 'bg-[#3b1c23]'
                            : 'bg-[#11131a]',
                    )}
                  >
                    <div className="flex items-center justify-between text-[0.86rem] leading-none tabular-nums">
                      <span className={cx(
                        isBest
                          ? 'font-semibold text-amber-300'
                          : isToday
                            ? 'font-semibold text-white'
                            : val > 0
                              ? 'text-[#39d98a]/85'
                              : val < 0
                                ? 'text-[#e56b7a]/85'
                                : 'text-zinc-500',
                      )}>
                        {day}
                      </span>
                      {info ? (
                        <span className={cx(
                          isBest
                            ? 'font-medium text-amber-300/90'
                            : val > 0
                              ? 'text-[#39d98a]/85'
                              : val < 0
                                ? 'text-[#e56b7a]/85'
                                : 'text-zinc-500',
                        )}>
                          {info.count}
                        </span>
                      ) : null}
                    </div>
                    <div className={cx(
                      'my-auto text-center text-[1.1rem] font-medium tracking-tight tabular-nums',
                      isBest
                        ? 'font-semibold text-amber-300'
                        : val > 0
                          ? 'text-[#38f29c]'
                          : val < 0
                            ? 'text-[#ff5c72]'
                            : 'text-zinc-600/80',
                    )}>
                      {info ? fmtVal(val, true) : fmtVal(0)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

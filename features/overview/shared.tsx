'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Copy } from '@/components/icons';
import { cx } from '@/components/ui';
import { fmtAgo, shortKey } from '@/lib/format';
import { useTerminal } from '@/lib/store';
import type { LanderId, RevertBreakdown, Venue } from '@/lib/types';

export const LANDER_NAME: Record<LanderId, string> = {
  jito: 'Jito', nozomi: 'Nozomi', stellium: 'Stellium', landx: 'LandX', bloom: 'Bloom / BlockRazor', astralane: 'Astralane', glaive: 'Glaive', fastlanes: 'Speed / FastLanes', tpu: 'Direct TPU',
};

export const VENUE_SHORT: Record<Venue, string> = {
  'Pump.fun': 'PUMP', PumpSwap: 'PUMPSWAP', 'Raydium LaunchLab': 'LAUNCHLAB', 'Raydium CPMM': 'CPMM',
};

export const REVERT_META: { key: keyof RevertBreakdown; label: string; short: string; cls: string }[] = [
  { key: 'duplicate', label: 'Duplicate (ring dedupe)', short: 'dup', cls: 'bg-zinc-500' },
  { key: 'mutex', label: 'Mutex in use', short: 'mutex', cls: 'bg-indigo-400' },
  { key: 'kolNotLanded', label: 'KOL not landed', short: 'kol', cls: 'bg-sky-400' },
  { key: 'slippage', label: 'Slippage', short: 'slip', cls: 'bg-amber-400' },
  { key: 'expired', label: 'Slot TTL expired', short: 'ttl', cls: 'bg-rose-400' },
];

export function RevertBar({ r, total, className }: { r: RevertBreakdown; total: number; className?: string }) {
  const sum = REVERT_META.reduce((a, m) => a + r[m.key], 0);
  const title = REVERT_META.filter((m) => r[m.key]).map((m) => `${m.label}: ${r[m.key]}`).join(' · ') || 'No reverts';
  return (
    <div className={cx('flex h-1.5 overflow-hidden rounded-full bg-line2', className)} role="img" aria-label={`Reverts: ${title}`} title={title}>
      {total > 0 && REVERT_META.map((m) => (r[m.key] ? <span key={m.key} className={m.cls} style={{ width: `${(r[m.key] / total) * 100}%` }} /> : null))}
      {total > 0 && sum < total && <span className="bg-emerald-400" style={{ width: `${((total - sum) / total) * 100}%` }} />}
    </div>
  );
}

function buildImageCandidates(image?: string, mint?: string): string[] {
  const out: string[] = [];
  const add = (u?: string) => {
    if (!u) return;
    const trimmed = u.trim();
    if (/^https?:\/\//i.test(trimmed) && !out.includes(trimmed)) out.push(trimmed);
  };
  if (image) {
    const raw = image.trim();
    const ipfsMatch = raw.match(/^(?:ipfs:\/\/|https?:\/\/[^/]+\/ipfs\/)(.+)$/i);
    if (ipfsMatch) {
      const cidPath = ipfsMatch[1].replace(/^ipfs\//i, '');
      add(`https://gateway.pinata.cloud/ipfs/${cidPath}`);
      add(`https://ipfs.io/ipfs/${cidPath}`);
      add(`https://dweb.link/ipfs/${cidPath}`);
    } else {
      add(raw);
    }
  }
  if (mint && mint.length >= 32) {
    add(`https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`);
    add(`https://images.pump.fun/coin-image/${mint}`);
  }
  return out;
}

// Token avatar/banner: locked 68×68px rounded-square with yellow/gold border and multi-CDN image fallback.
export function TokenAvatar({ symbol, image, mint }: { symbol: string; image?: string; mint?: string }) {
  const candidates = buildImageCandidates(image, mint);
  const key = `${image ?? ''}|${mint ?? ''}`;
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [key]);

  const src = candidates[idx];
  const showImg = !!src;
  return (
    <span
      style={{ width: 68, height: 68, borderRadius: 15 }}
      className={cx(
        'grid shrink-0 place-items-center overflow-hidden border-[1.5px] border-amber-400/85 shadow-[0_0_14px_rgba(251,191,36,0.14)]',
        showImg
          ? 'bg-[#16181e]'
          : 'bg-[#22252d] text-xl font-bold text-[#d4d8e2] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_14px_rgba(251,191,36,0.14)]',
      )}
    >
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setIdx((n) => n + 1)}
          style={{ width: 68, height: 68, objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <span aria-hidden>{(symbol[0] || '?').toUpperCase()}</span>
      )}
    </span>
  );
}

function LaunchTimer({ ts }: { ts: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="num font-semibold text-emerald-400">{fmtAgo(ts, now)}</span>;
}

export function TokenCell({ symbol, badge, sub, mint, ts, image }: { symbol: string; badge: string; sub: ReactNode; mint?: string; ts?: number; image?: string }) {
  const { toast } = useTerminal();
  const copyMint = async () => {
    if (!mint) return;
    try { await navigator.clipboard.writeText(mint); toast(`Copied ${shortKey(mint, 4)}`, 'ok'); }
    catch { toast('Copy failed', 'error'); }
  };
  return (
    <div className="flex min-w-0 items-center gap-3.5">
      <TokenAvatar symbol={symbol} image={image} mint={mint} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[0.97rem] font-semibold leading-snug">
          <span className="truncate">${symbol}</span>
          <span className="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[0.64rem] font-bold tracking-wider text-fg2">{badge}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[0.84rem] text-muted">
          {ts != null && ts > 0 && <LaunchTimer ts={ts} />}
          <span className="truncate">{sub}</span>
        </div>
        {mint && (
          <div className="mt-0.5 flex items-center gap-1 text-[0.75rem] text-muted">
            <a
              href={`https://solscan.io/token/${encodeURIComponent(mint)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={mint}
              className="num truncate hover:text-fg"
            >
              {shortKey(mint, 6)}
            </a>
            <button
              type="button"
              onClick={copyMint}
              aria-label={`Copy ${symbol} mint address`}
              className="rounded p-0.5 text-muted hover:text-fg"
            >
              <Copy className="size-2.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Two-line numeric cell: primary value over a muted secondary (reference style). */
export function NumCell({ top, bottom, topCls }: { top: ReactNode; bottom?: ReactNode; topCls?: string }) {
  return (
    <div className="flex flex-col items-end gap-0.5 tabular-nums">
      <span className={cx('text-[0.95rem] font-medium', topCls)}>{top}</span>
      {bottom != null && <span className="text-[0.88rem] text-muted">{bottom}</span>}
    </div>
  );
}

export function PctChip({ v }: { v: number }) {
  const t = v > 0 ? 'bg-emerald-400/12 text-emerald-400' : v < 0 ? 'bg-rose-400/13 text-rose-400' : 'bg-raised text-fg2';
  return <span className={cx('rounded-md px-1.5 py-0.5 text-[0.8rem] font-semibold tabular-nums', t)}>{v > 0 ? '+' : v < 0 ? '−' : ''}{Math.abs(v).toFixed(1)}%</span>;
}

export function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'ok' | 'bad' | 'info' }) {
  const t = {
    neutral: 'border-line2 bg-raised text-fg2',
    warn: 'border-amber-400/35 bg-amber-400/10 text-amber-300',
    ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    bad: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
    info: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  }[tone];
  return <span className={cx('inline-flex whitespace-nowrap rounded-[0.55rem] border px-2.5 py-1 text-[0.88rem]', t)}>{children}</span>;
}

/** Table header / cell in the reference style (sentence case, generous rows). */
export function RTh({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <th scope="col" className={cx('whitespace-nowrap border-b border-line px-4 py-3 text-[0.88rem] font-semibold text-fg2 first:pl-7 last:pr-7', right ? 'text-right' : 'text-left', className)}>{children}</th>;
}
export function RTd({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={cx('border-b border-line px-4 py-3.5 align-middle first:pl-7 last:pr-7', right && 'text-right', className)}>{children}</td>;
}

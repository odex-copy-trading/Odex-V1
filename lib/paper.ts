'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TerminalState } from '@/lib/types';

export const PAPER_BAL_KEY = 'whal.paperBalanceSol';
const PAPER_EVENT = 'whal:paper-balance';
const DEFAULT_PAPER_SOL = 10;

function readPaperBalance(): number {
  if (typeof window === 'undefined') return DEFAULT_PAPER_SOL;
  try {
    const raw = localStorage.getItem(PAPER_BAL_KEY);
    if (raw == null) return DEFAULT_PAPER_SOL;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PAPER_SOL;
  } catch {
    return DEFAULT_PAPER_SOL;
  }
}

export function usePaperBalance(): [number, (next: number) => void] {
  const [paperStartSol, setPaperStartSol] = useState<number>(DEFAULT_PAPER_SOL);

  useEffect(() => {
    setPaperStartSol(readPaperBalance());
    const sync = () => setPaperStartSol(readPaperBalance());
    window.addEventListener(PAPER_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PAPER_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((next: number) => {
    setPaperStartSol(next);
    try {
      localStorage.setItem(PAPER_BAL_KEY, String(next));
      window.dispatchEvent(new Event(PAPER_EVENT));
    } catch { /* ignore */ }
  }, []);

  return [paperStartSol, update];
}

/** Computes live Shadow Paper Wallet equity in SOL from starting bankroll + open paper positions + verified closed paper PnL. */
export function computePaperEquitySol(state: TerminalState, startingSol: number): number {
  const paperOpen = state.positions.filter((p) => p.id.startsWith('paper_'));
  const openCost = paperOpen.reduce((a, p) => a + p.entrySol, 0);
  const openVal = paperOpen.reduce((a, p) => a + p.tokens * p.price + (p.proceedsSol ?? 0), 0);
  const paperClosed = state.closed.filter((c) => c.id.startsWith('cl_paper_'));
  const realizedSol = paperClosed.reduce((a, c) => a + (c.proceedsSol - c.entrySol), 0);
  return Math.max(0, startingSol - openCost + openVal + realizedSol);
}

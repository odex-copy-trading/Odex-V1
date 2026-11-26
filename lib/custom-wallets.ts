'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '@/lib/store';

export const CUSTOM_WALLETS_KEY = 'odex.customWallets.v1';
const CUSTOM_WALLETS_EVENT = 'odex:custom-wallets';
const BALANCES_EVENT = 'odex:custom-wallet-balances';

export type WalletAsset = 'sol' | 'usdc';

export interface CustomWallet {
  id: string;
  title: string;
  badge: string;
  asset: WalletAsset;
  providerLabel: string;
  address: string;
}

export interface OnChainWalletBalance {
  sol: number;
  usdc: number;
}

let cachedBalances: Record<string, OnChainWalletBalance> = {};
let inflightKey = '';
let inflightPromise: Promise<void> | null = null;

export function readCustomWallets(): CustomWallet[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_WALLETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((w) => w && typeof w.address === 'string' && typeof w.title === 'string')
      .map((w) => ({
        id: String(w.id || `w_${w.address.slice(0, 8)}`),
        title: String(w.title),
        badge: String(w.badge || 'Custom'),
        asset: w.asset === 'usdc' ? 'usdc' : 'sol',
        providerLabel: String(w.providerLabel || (w.asset === 'usdc' ? 'SPL USDC · Custom' : 'Solana · Custom')),
        address: String(w.address),
      }));
  } catch {
    return [];
  }
}

export function writeCustomWallets(next: CustomWallet[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CUSTOM_WALLETS_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(CUSTOM_WALLETS_EVENT, { detail: next }));
  } catch { /* ignore storage quota errors */ }
}

async function fetchLiveBalances(addresses: string[], force = false): Promise<void> {
  if (typeof window === 'undefined') return;
  const unique = [...new Set(addresses.filter(Boolean))];
  if (unique.length === 0) return;
  const key = unique.slice().sort().join(',');
  if (!force && inflightPromise && inflightKey === key) return inflightPromise;

  const jwt = window.sessionStorage.getItem('whal.jwt');
  if (!jwt) return;

  inflightKey = key;
  inflightPromise = (async () => {
    try {
      const r = await fetch(`${API_URL}/api/wallets/balances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ addresses: unique }),
      });
      if (!r.ok) return;
      const data = (await r.json()) as { balances?: Record<string, OnChainWalletBalance> };
      if (data.balances) {
        cachedBalances = { ...cachedBalances, ...data.balances };
        window.dispatchEvent(new CustomEvent(BALANCES_EVENT, { detail: cachedBalances }));
      }
    } catch { /* transient network error */ }
    finally {
      inflightPromise = null;
    }
  })();

  return inflightPromise;
}

/** Reactive hook syncing custom/generated wallets + their LIVE on-chain SOL/USDC balances across the entire app. */
export function useCustomWallets() {
  const [wallets, setWallets] = useState<CustomWallet[]>([]);
  const [balancesByAddr, setBalancesByAddr] = useState<Record<string, OnChainWalletBalance>>(cachedBalances);

  useEffect(() => {
    const initial = readCustomWallets();
    setWallets(initial);
    setBalancesByAddr(cachedBalances);

    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<CustomWallet[]>).detail;
      setWallets(Array.isArray(detail) ? detail : readCustomWallets());
    };
    const onBalances = (e: Event) => {
      const detail = (e as CustomEvent<Record<string, OnChainWalletBalance>>).detail;
      if (detail) setBalancesByAddr({ ...detail });
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === CUSTOM_WALLETS_KEY) setWallets(readCustomWallets());
    };
    window.addEventListener(CUSTOM_WALLETS_EVENT, onCustom);
    window.addEventListener(BALANCES_EVENT, onBalances);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CUSTOM_WALLETS_EVENT, onCustom);
      window.removeEventListener(BALANCES_EVENT, onBalances);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const addrKey = wallets.map((w) => w.address).sort().join(',');

  useEffect(() => {
    if (!addrKey) return;
    const addrs = addrKey.split(',');
    void fetchLiveBalances(addrs);
    const id = window.setInterval(() => { void fetchLiveBalances(addrs, true); }, 15_000);
    return () => window.clearInterval(id);
  }, [addrKey]);

  const setAll = useCallback((next: CustomWallet[]) => {
    setWallets(next);
    writeCustomWallets(next);
    if (next.length > 0) void fetchLiveBalances(next.map((w) => w.address), true);
  }, []);

  const refreshBalances = useCallback(async () => {
    await fetchLiveBalances(wallets.map((w) => w.address), true);
  }, [wallets]);

  const sumExcluding = useCallback((exclude: (string | null | undefined)[]) => {
    const skip = new Set(exclude.filter((a): a is string => !!a));
    const seen = new Set<string>();
    let sol = 0;
    let usdc = 0;
    for (const w of wallets) {
      if (skip.has(w.address) || seen.has(w.address)) continue;
      seen.add(w.address);
      const b = balancesByAddr[w.address];
      if (b) {
        sol += b.sol;
        usdc += b.usdc;
      }
    }
    return { sol, usdc };
  }, [wallets, balancesByAddr]);

  return { wallets, setAll, balancesByAddr, refreshBalances, sumExcluding };
}

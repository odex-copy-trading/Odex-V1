'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface PhantomPublicKey {
  toBase58?: () => string;
  toString: () => string;
}

interface PhantomProviderApi {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: PhantomPublicKey | null;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PhantomPublicKey }>;
  disconnect: () => Promise<void>;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  off?: (event: string, cb: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    phantom?: { solana?: PhantomProviderApi };
    solana?: PhantomProviderApi;
  }
}

export interface PhantomState {
  installed: boolean;
  connected: boolean;
  connecting: boolean;
  publicKey: string | null;
  solBalance: number | null;
  error: string | null;
  connect: () => Promise<string | null>;
  disconnect: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

const PhantomCtx = createContext<PhantomState | null>(null);

function getProvider(): PhantomProviderApi | null {
  if (typeof window === 'undefined') return null;
  const p = window.phantom?.solana ?? window.solana;
  return p?.isPhantom ? p : null;
}

function pkToString(pk: PhantomPublicKey | null | undefined): string | null {
  if (!pk) return null;
  return typeof pk.toBase58 === 'function' ? pk.toBase58() : pk.toString();
}

export function PhantomProvider({ children }: { children: ReactNode }) {
  const [installed, setInstalled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = useCallback(async (pk: string) => {
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pk, { commitment: 'confirmed' }] }),
      });
      if (!r.ok) return;
      const j = (await r.json()) as { result?: { value?: number } };
      if (typeof j.result?.value === 'number') setSolBalance(j.result.value / 1e9);
    } catch { /* ignore transient RPC errors */ }
  }, []);

  useEffect(() => {
    const provider = getProvider();
    setInstalled(!!provider);
    if (!provider) return;

    const onConnect = (pk: unknown) => {
      const addr = pkToString((pk as PhantomPublicKey) ?? provider.publicKey);
      setPublicKey(addr);
      setError(null);
      if (addr) void fetchBalance(addr);
    };
    const onDisconnect = () => {
      setPublicKey(null);
      setSolBalance(null);
    };
    const onAccountChanged = (pk: unknown) => {
      const addr = pkToString(pk as PhantomPublicKey | null);
      setPublicKey(addr);
      if (addr) void fetchBalance(addr);
      else setSolBalance(null);
    };

    provider.on?.('connect', onConnect);
    provider.on?.('disconnect', onDisconnect);
    provider.on?.('accountChanged', onAccountChanged);

    // Silent auto-reconnect if previously approved in Phantom
    if (provider.isConnected && provider.publicKey) {
      onConnect(provider.publicKey);
    } else {
      provider.connect({ onlyIfTrusted: true }).then((res) => onConnect(res.publicKey)).catch(() => {});
    }

    return () => {
      provider.off?.('connect', onConnect);
      provider.off?.('disconnect', onDisconnect);
      provider.off?.('accountChanged', onAccountChanged);
      provider.removeListener?.('connect', onConnect);
      provider.removeListener?.('disconnect', onDisconnect);
      provider.removeListener?.('accountChanged', onAccountChanged);
    };
  }, [fetchBalance]);

  useEffect(() => {
    if (!publicKey) return;
    const id = setInterval(() => void fetchBalance(publicKey), 20_000);
    return () => clearInterval(id);
  }, [publicKey, fetchBalance]);

  const connect = useCallback(async (): Promise<string | null> => {
    const provider = getProvider();
    if (!provider) {
      setInstalled(false);
      setError('Phantom browser extension not detected');
      return null;
    }
    setInstalled(true);
    setConnecting(true);
    setError(null);
    try {
      const res = await provider.connect();
      const addr = pkToString(res.publicKey);
      setPublicKey(addr);
      if (addr) void fetchBalance(addr);
      return addr;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Phantom connection rejected');
      return null;
    } finally {
      setConnecting(false);
    }
  }, [fetchBalance]);

  const disconnect = useCallback(async () => {
    const provider = getProvider();
    try { await provider?.disconnect(); } catch { /* ignore */ }
    setPublicKey(null);
    setSolBalance(null);
    setError(null);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (publicKey) await fetchBalance(publicKey);
  }, [publicKey, fetchBalance]);

  const value = useMemo<PhantomState>(
    () => ({
      installed,
      connected: !!publicKey,
      connecting,
      publicKey,
      solBalance,
      error,
      connect,
      disconnect,
      refreshBalance,
    }),
    [installed, publicKey, connecting, solBalance, error, connect, disconnect, refreshBalance],
  );

  return <PhantomCtx.Provider value={value}>{children}</PhantomCtx.Provider>;
}

export function usePhantom(): PhantomState {
  const ctx = useContext(PhantomCtx);
  if (!ctx) throw new Error('usePhantom must be used inside PhantomProvider');
  return ctx;
}

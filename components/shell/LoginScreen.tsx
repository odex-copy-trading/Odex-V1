'use client';

import { useState } from 'react';
import { Lock } from '@/components/icons';
import { Button } from '@/components/ui';
import { API_URL, useTerminal } from '@/lib/store';

export function LoginScreen() {
  const { auth } = useTerminal();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try { await auth.login(token.trim()); setToken(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-bg p-4">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="w-full max-w-sm rounded-[1.4rem] border border-line2 bg-panel p-7">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="" className="mb-5 size-11 rounded-xl" />
        <h1 className="text-2xl font-bold tracking-tight">Sign in to Odex Bot</h1>
        <p className="mt-1.5 text-sm text-fg2">Enter the operator token printed by <code className="num text-[0.8rem] text-fg">npm run server:keys</code>.</p>
        <label htmlFor="op-token" className="mt-6 block text-xs font-medium text-fg2">Operator token</label>
        <input id="op-token" type="password" autoComplete="current-password" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} autoFocus
          className="mt-1.5 h-10 w-full rounded-[0.7rem] border border-line2 bg-card px-3 text-sm outline-none focus:border-accent" aria-invalid={!!error || undefined} aria-describedby={error ? 'login-err' : undefined} />
        {error && <p id="login-err" role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 16} className="mt-5 h-10 w-full" icon={Lock}>Sign in</Button>
        <p className="mt-4 text-xs text-muted">Control plane: <span className="num">{API_URL}</span>. The session ends when you close this tab.</p>
      </form>
    </main>
  );
}

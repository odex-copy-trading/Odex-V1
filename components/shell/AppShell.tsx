'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Activity, Radio, Settings, Users, Wallet, WifiOff, X, Zap, type LucideIcon } from '@/components/icons';
import { cx } from '@/components/ui';
import { BottomBar, EngineRailButton, KillSwitchRailButton, TopBar } from '@/components/shell/StatusBar';
import { TerminalProvider, useTerminal } from '@/lib/store';
import { LoginScreen } from '@/components/shell/LoginScreen';

const NAV: { href: string; label: string; short: string; icon: LucideIcon }[] = [
  { href: '/', label: 'Overview / Live feed', short: 'Live', icon: Radio },
  { href: '/watchlist', label: 'KOL watchlist', short: 'KOLs', icon: Users },
  { href: '/execution', label: 'Execution & landers', short: 'Landers', icon: Zap },
  { href: '/treasury', label: 'Treasury & inventory', short: 'Treasury', icon: Wallet },
];
const DIAGNOSTICS = { href: '/diagnostics', label: 'Bug & system diagnostics', short: 'Diag', icon: Activity };
const SETTINGS = { href: '/settings', label: 'Settings', short: 'Settings', icon: Settings };

function RailLink({ item, active }: { item: typeof SETTINGS; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-label={item.label} aria-current={active ? 'page' : undefined}
      className={cx('group relative grid size-11 place-items-center rounded-xl text-muted transition-colors hover:bg-raised hover:text-fg', active && 'bg-raised text-fg')}>
      <Icon className="size-5" aria-hidden />
      <span className="pointer-events-none absolute left-13 z-50 whitespace-nowrap rounded-lg border border-line2 bg-raised px-2 py-1 text-xs text-fg opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{item.label}</span>
    </Link>
  );
}

function Rail() {
  const path = usePathname();
  const isActive = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <>
      <nav aria-label="Primary" className="sticky top-0 z-40 hidden h-screen w-16 shrink-0 flex-col items-center gap-2 border-r border-line bg-bg py-3 md:flex">
        <Link href="/" aria-label="Whal Bot home" className="mb-5 block size-9 overflow-hidden rounded-[0.65rem]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="size-full" />
        </Link>
        {NAV.map((n) => <RailLink key={n.href} item={n} active={isActive(n.href)} />)}
        <div className="mt-auto flex flex-col items-center gap-2">
          <EngineRailButton />
          <KillSwitchRailButton />
          <span aria-hidden className="my-0.5 h-px w-7 bg-line" />
          <RailLink item={DIAGNOSTICS} active={isActive(DIAGNOSTICS.href)} />
          <RailLink item={SETTINGS} active={isActive(SETTINGS.href)} />
        </div>
      </nav>
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex h-15 items-stretch justify-around border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] md:hidden">
        {[...NAV, DIAGNOSTICS, SETTINGS].map((n) => {
          const Icon = n.icon, a = isActive(n.href);
          return (
            <Link key={n.href} href={n.href} aria-current={a ? 'page' : undefined}
              className={cx('flex flex-1 flex-col items-center justify-center gap-0.5 text-[0.65rem]', a ? 'text-fg' : 'text-muted')}>
              <Icon className="size-5" aria-hidden />{n.short}
            </Link>
          );
        })}
      </nav>
    </>
  );
}

function ConnectionBanner() {
  const { state } = useTerminal();
  if (state.connection !== 'reconnecting' && state.connection !== 'closed') return null;
  return (
    <div role="alert" className="mx-3 mt-3 flex items-center gap-2 rounded-xl border border-rose-400/35 bg-rose-400/10 px-3 py-2 text-sm text-rose-200 md:mx-5">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      Connection to the bot lost. Reconnecting… Values below are frozen at the last update{state.lastMessageAt ? ` (${new Date(state.lastMessageAt).toLocaleTimeString('en-GB')})` : ''}.
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useTerminal();
  return (
    <div aria-live="polite" className="fixed bottom-28 right-3 z-60 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 md:bottom-12">
      {toasts.map((t) => (
        <div key={t.id} className={cx('flex items-start gap-2 rounded-xl border bg-raised px-3 py-2.5 text-sm shadow-xl',
          t.tone === 'error' ? 'border-rose-400/50' : t.tone === 'ok' ? 'border-emerald-400/40' : 'border-line2')}>
          <span className="flex-1">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="text-muted hover:text-fg"><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const { auth } = useTerminal();
  return auth.required ? <LoginScreen /> : <>{children}</>;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TerminalProvider>
      <Gate>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-lg focus:bg-fg focus:px-3 focus:py-2 focus:text-black">Skip to content</a>
      <div className="flex min-h-screen">
        <Rail />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col pb-15 md:pb-0">
          <TopBar />
          <ConnectionBanner />
          <main id="main" className="min-w-0 flex-1 px-3 pb-8 pt-6 md:px-7 md:pb-10 xl:px-10">{children}</main>
          <BottomBar />
        </div>
      </div>
      </Gate>
      <Toasts />
    </TerminalProvider>
  );
}

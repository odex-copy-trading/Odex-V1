'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Copy, Download, Eye, Pencil, Power, Settings, Wallet } from '@/components/icons';
import { Button, Modal, PageHeader, cx } from '@/components/ui';
import { fmtSol, fmtUsd, shortKey } from '@/lib/format';
import { computePaperEquitySol, usePaperBalance } from '@/lib/paper';
import { usePhantom } from '@/lib/phantom';
import { useTerminal } from '@/lib/store';

const PAPER_PRESETS = [5, 10, 25, 100];

function SolanaMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 397.7 311.7" className={cx(className, 'shrink-0')} aria-hidden>
      <defs>
        <linearGradient id="wallets-sol-grad" x1="360.88" y1="351.46" x2="141.21" y2="-69.29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <path fill="url(#wallets-sol-grad)" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
      <path fill="url(#wallets-sol-grad)" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
      <path fill="url(#wallets-sol-grad)" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
    </svg>
  );
}

function WalletCard({
  title,
  badge,
  badgeTone = 'amber',
  activeHighlight = false,
  providerLabel,
  subtitleNote = 'on-chain',
  address,
  sol,
  usdc,
  solUsd,
  primaryAction,
  secondaryAction,
  onReceive,
  onCopy,
}: {
  title: string;
  badge: string;
  badgeTone?: 'amber' | 'emerald' | 'sky';
  activeHighlight?: boolean;
  providerLabel: string;
  subtitleNote?: string;
  address: string | null;
  sol: number;
  usdc: number;
  solUsd: number;
  primaryAction: React.ReactNode;
  secondaryAction?: React.ReactNode;
  onReceive?: () => void;
  onCopy: (addr: string) => void;
}) {
  const onChainUsd = sol * solUsd + usdc;
  return (
    <div className={cx(
      'relative overflow-hidden rounded-[1.35rem] border bg-gradient-to-br from-[#141622] via-[#10111a] to-[#0c0d14] p-6 shadow-xl transition-colors',
      activeHighlight ? 'border-emerald-400/45 shadow-[0_0_24px_rgba(16,185,129,0.12)]' : 'border-white/[0.08]',
    )}>
      {/* Subtle large Solana watermark */}
      <svg viewBox="0 0 397.7 311.7" aria-hidden className="pointer-events-none absolute right-28 top-1/2 w-40 -translate-y-1/2 opacity-[0.045]">
        <path fill="#14F195" d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z" />
        <path fill="#00C2FF" d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z" />
        <path fill="#9945FF" d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z" />
      </svg>

      {/* Top row: Wallet identity + Solana network pill */}
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <span className="grid size-12 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-black/55">
            <SolanaMark className="size-5.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[1.08rem] font-semibold tracking-tight text-white">{title}</h2>
              <span className={cx(
                'rounded-md border px-2 py-0.5 text-[0.68rem] font-semibold',
                badgeTone === 'amber'
                  ? 'border-amber-400/35 bg-amber-400/12 text-amber-300'
                  : badgeTone === 'sky'
                    ? 'border-sky-400/35 bg-sky-400/12 text-sky-300'
                    : 'border-emerald-400/35 bg-emerald-400/12 text-emerald-300',
              )}>
                {badge}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted">
              <span className="num text-fg2" title={address ?? undefined}>{address ? shortKey(address, 4) : 'Not connected'}</span>
              {address && (
                <button
                  type="button"
                  onClick={() => onCopy(address)}
                  aria-label={`Copy ${title} address`}
                  className="grid size-6 place-items-center rounded-full bg-white/[0.07] text-fg2 hover:bg-white/[0.14] hover:text-fg"
                >
                  <Copy className="size-3" />
                </button>
              )}
              <span>· {providerLabel}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {secondaryAction}
          <span className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-black/45 px-3.5 py-1.5 text-xs font-medium text-fg">
            <SolanaMark className="size-3.5" />
            Solana
          </span>
        </div>
      </div>

      {/* Bottom row: Big balance + action pills */}
      <div className="relative mt-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-2 tabular-nums">
            <span className="text-[2.15rem] font-bold leading-none tracking-tight text-white">{fmtSol(sol, 4)}</span>
            <span className="text-base font-medium text-fg2">SOL · {usdc.toFixed(2)} USDC</span>
          </div>
          <div className="mt-1.5 text-xs text-muted tabular-nums">
            ≈ {fmtUsd(onChainUsd)} {subtitleNote}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {address && onReceive && (
            <button
              type="button"
              onClick={onReceive}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-fg transition-colors hover:bg-white/[0.09]"
            >
              <Download className="size-4 text-fg2" aria-hidden />
              Receive
            </button>
          )}
          {address && (
            <a
              href={`https://solscan.io/account/${encodeURIComponent(address)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-fg transition-colors hover:bg-white/[0.09]"
            >
              <ArrowUpRight className="size-4 text-fg2" aria-hidden />
              Explorer
            </a>
          )}
          {primaryAction}
        </div>
      </div>
    </div>
  );
}

export function WalletsView() {
  const { state, toast } = useTerminal();
  const phantom = usePhantom();
  const [paperStartSol, setPaperStartSol] = usePaperBalance();
  const [receiveAddr, setReceiveAddr] = useState<{ label: string; addr: string } | null>(null);
  const [paperModal, setPaperModal] = useState(false);
  const [paperInput, setPaperInput] = useState<string>(String(paperStartSol));

  const savePaperBalance = (val: number) => {
    if (!Number.isFinite(val) || val < 0 || val > 1_000_000) {
      toast('Enter a valid SOL amount (0 – 1,000,000)', 'error');
      return;
    }
    setPaperStartSol(val);
    setPaperInput(String(val));
    setPaperModal(false);
    toast(`Shadow paper balance set to ${fmtSol(val, 2)} SOL`, 'ok');
  };

  const b = state.balances;
  const isShadow = state.engine.status === 'SHADOW';
  const hotWallet = state.config?.config.wallets.hot_wallet_pubkey || null;
  const paperBuySol = state.config?.config.strategy.default_buy_sol ?? 1;
  const paperOpen = state.positions.filter((p) => p.id.startsWith('paper_'));
  const paperOpenVal = paperOpen.reduce((a, p) => a + p.tokens * p.price, 0);
  const paperEquitySol = computePaperEquitySol(state, paperStartSol);

  const copyAddr = async (addr: string) => {
    try { await navigator.clipboard.writeText(addr); toast('Address copied', 'ok'); }
    catch { toast('Copy failed', 'error'); }
  };

  const shadowCard = (
    <WalletCard
      key="shadow"
      title="Shadow Paper Wallet"
      badge={isShadow ? '● Active' : 'Standby'}
      badgeTone={isShadow ? 'emerald' : 'sky'}
      activeHighlight={isShadow}
      providerLabel="Paper Simulator"
      subtitleNote={`paper equity · ${paperOpen.length} open`}
      address="ShadowPaper1111111111111111111111111111111"
      sol={paperEquitySol}
      usdc={0}
      solUsd={b.solUsd}
      onCopy={copyAddr}
      primaryAction={
        <button
          type="button"
          onClick={() => { setPaperInput(String(paperStartSol)); setPaperModal(true); }}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-[#6c75f5] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#7c84ff]"
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit Paper Balance
        </button>
      }
    />
  );

  const phantomCard = (
    <WalletCard
      key="phantom"
      title="Solana Wallet"
      badge="Default"
      badgeTone="amber"
      providerLabel="Phantom"
      address={phantom.publicKey}
      sol={phantom.solBalance ?? 0}
      usdc={0}
      solUsd={b.solUsd}
      onCopy={copyAddr}
      onReceive={phantom.publicKey ? () => setReceiveAddr({ label: 'Phantom Wallet', addr: phantom.publicKey! }) : undefined}
      secondaryAction={
        phantom.connected ? (
          <button
            type="button"
            onClick={() => void phantom.disconnect().then(() => toast('Phantom disconnected', 'info'))}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs font-medium text-fg2 hover:bg-white/[0.09] hover:text-rose-300"
          >
            <Power className="size-3.5" aria-hidden />
            Disconnect
          </button>
        ) : null
      }
      primaryAction={
        phantom.connected ? (
          <button
            type="button"
            onClick={() => { setPaperInput(String(paperStartSol)); setPaperModal(true); }}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-[#6c75f5] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#7c84ff]"
          >
            <span aria-hidden>$</span>
            Paper balance
          </button>
        ) : phantom.installed ? (
          <button
            type="button"
            disabled={phantom.connecting}
            onClick={() => void phantom.connect().then((pk) => { if (pk) toast(`Connected Phantom (${shortKey(pk, 4)})`, 'ok'); })}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[#6c75f5] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#7c84ff] disabled:opacity-60"
          >
            <Wallet className="size-4" aria-hidden />
            {phantom.connecting ? 'Connecting…' : 'Connect Phantom'}
          </button>
        ) : (
          <a
            href="https://phantom.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-[#6c75f5] px-5 text-sm font-semibold text-white transition-colors hover:bg-[#7c84ff]"
          >
            Install Phantom
          </a>
        )
      }
    />
  );

  const botCard = (
    <WalletCard
      key="bot"
      title="Bot Trading Wallet"
      badge={!isShadow && state.engineSource === 'bridge' ? '● Active' : isShadow ? 'Standby (Shadow ON)' : 'Configured'}
      badgeTone={!isShadow && state.engineSource === 'bridge' ? 'emerald' : 'amber'}
      activeHighlight={!isShadow && state.engineSource === 'bridge'}
      providerLabel="Engine Host"
      address={hotWallet}
      sol={b.sol + b.wsol}
      usdc={b.usdc}
      solUsd={b.solUsd}
      onCopy={copyAddr}
      onReceive={hotWallet ? () => setReceiveAddr({ label: 'Bot Trading Wallet', addr: hotWallet }) : undefined}
      primaryAction={
        <Link
          href="/settings"
          className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-5 text-sm font-semibold text-fg transition-colors hover:bg-white/[0.12]"
        >
          <Settings className="size-4" aria-hidden />
          Configure
        </Link>
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Wallets"
        sub={
          isShadow
            ? 'Shadow mode is ON — Shadow Paper Wallet is active for all simulated trades.'
            : 'Connected Phantom browser wallet and engine hot trading wallet on Solana mainnet.'
        }
      />

      <div className="grid gap-5">
        {isShadow ? (
          <>
            {shadowCard}
            {phantomCard}
            {botCard}
          </>
        ) : (
          <>
            {phantomCard}
            {botCard}
            {shadowCard}
          </>
        )}
      </div>

      {/* Receive modal */}
      <Modal open={!!receiveAddr} onClose={() => setReceiveAddr(null)} title={`Receive SOL · ${receiveAddr?.label ?? ''}`}>
        <p className="text-sm text-fg2">Send native Solana (SOL) or SPL tokens to this address:</p>
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-line2 bg-card px-3 py-2.5">
          <code className="num break-all text-xs text-fg">{receiveAddr?.addr}</code>
          {receiveAddr && <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copyAddr(receiveAddr.addr)}>Copy</Button>}
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={() => setReceiveAddr(null)}>Close</Button></div>
      </Modal>

      {/* Editable Paper balance modal */}
      <Modal open={paperModal} onClose={() => setPaperModal(false)} title="Edit Shadow Paper Balance">
        <form
          className="space-y-4 text-sm"
          onSubmit={(e) => { e.preventDefault(); savePaperBalance(Number(paperInput)); }}
        >
          <p className="text-fg2">
            Set your simulated <b className="text-fg">Shadow Mode</b> bankroll in SOL. Trades use real live Pump.fun prices without spending any real funds.
          </p>

          <div>
            <label htmlFor="paper-sol-input" className="text-xs font-medium text-fg2">Starting Paper Balance (SOL)</label>
            <div className="relative mt-1.5">
              <input
                id="paper-sol-input"
                type="number"
                step="any"
                min="0"
                max="1000000"
                data-autofocus
                value={paperInput}
                onChange={(e) => setPaperInput(e.target.value)}
                className="num h-10 w-full rounded-xl border border-line2 bg-card px-3.5 pr-14 text-base font-semibold text-fg outline-none focus:border-accent"
              />
              <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">SOL</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {PAPER_PRESETS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setPaperInput(String(n))}
                  className={cx(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    Number(paperInput) === n
                      ? 'border-[#6c75f5] bg-[#6c75f5]/20 text-white'
                      : 'border-line2 bg-card text-fg2 hover:bg-raised hover:text-fg',
                  )}
                >
                  {n} SOL
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-card p-3.5 tabular-nums">
            <div>
              <div className="text-xs text-muted">Paper buy size</div>
              <div className="mt-0.5 text-base font-bold text-fg">{fmtSol(paperBuySol, 2)} SOL</div>
            </div>
            <div>
              <div className="text-xs text-muted">Open paper value</div>
              <div className="mt-0.5 text-base font-bold text-fg">{fmtSol(paperOpenVal, 3)} SOL</div>
            </div>
            <div>
              <div className="text-xs text-muted">Open paper positions</div>
              <div className="mt-0.5 font-semibold text-fg">{paperOpen.length} / 5</div>
            </div>
            <div>
              <div className="text-xs text-muted">Session realized PnL</div>
              <div className={cx('mt-0.5 font-semibold', state.session.realizedSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {fmtSol(state.session.realizedSol, 4, true)} SOL
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Eye className="size-3.5 text-sky-400" aria-hidden />
              ≈ {fmtUsd((Number(paperInput) || 0) * b.solUsd)}
            </span>
            <div className="flex gap-2">
              <Button onClick={() => setPaperModal(false)}>Cancel</Button>
              <Button type="submit" variant="primary">Save balance</Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}

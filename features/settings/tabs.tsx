'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check, Lock, Plus, Power, RefreshCw, Trash2, WifiOff } from '@/components/icons';
import { Badge, Button, Modal, Toggle, cx } from '@/components/ui';
import { useCommand, useTerminal } from '@/lib/store';
import { fmtAgo, fmtSol, shortKey } from '@/lib/format';
import { LANDER_IDS, LANDER_LABEL, SECRETS, type BotConfig, type LanderKey } from '@/lib/config/schema';
import { ListField, NumField, RestartTag, Section, SelectField, SlotRangeField, TextField, ToggleField, getAt, useForm } from './form';

// ---------- secrets ----------
export function SecretField({ id }: { id: string }) {
  const { state } = useTerminal();
  const { run, busy } = useCommand();
  const meta = SECRETS.find((s) => s.id === id)!;
  const status = state.config?.secrets[id] ?? { set: false, updatedAt: null };
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const close = () => { setOpen(false); setValue(''); };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-2 text-[0.8rem] font-medium text-fg2">{meta.label}<span className="inline-flex items-center gap-1 rounded-md border border-line2 bg-raised px-1.5 py-px text-[0.65rem] font-semibold uppercase tracking-wide text-fg2"><Lock className="size-2.5" aria-hidden />Secret</span></span>
      <div className="flex h-9 items-center gap-2 rounded-[0.65rem] border border-line2 bg-card pl-3 pr-1">
        <span className={cx('flex-1 truncate text-sm', status.set ? 'text-emerald-300' : 'text-muted')}>
          {status.set ? <><Check className="mr-1 inline size-3.5" aria-hidden />Set{status.updatedAt ? ` · ${fmtAgo(status.updatedAt)} ago` : ''}</> : 'Not set'}
        </span>
        {meta.uiSettable && <>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{status.set ? 'Replace' : 'Set'}</Button>
          {status.set && <Button size="sm" variant="ghost" aria-label={`Clear ${meta.label}`} icon={Trash2} className="hover:text-rose-300" loading={busy} onClick={() => run({ type: 'secret.clear', id }, `${meta.label} cleared`)} />}
        </>}
      </div>
      <p className="text-xs text-muted">{meta.hint ?? 'Stored encrypted on the engine. Never shown again after saving.'}</p>
      <Modal open={open} onClose={close} title={`${status.set ? 'Replace' : 'Set'} ${meta.label}`}>
        <form className="grid gap-4" onSubmit={async (e) => { e.preventDefault(); if (value && await run({ type: 'secret.set', id, value }, `${meta.label} saved`)) close(); }}>
          <p className="text-sm text-fg2">Sent once to the engine, encrypted at rest (ChaCha20-Poly1305) and never returned to the browser. Applies without a restart.</p>
          <input type="password" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} aria-label={meta.label} data-autofocus
            className="h-9 w-full rounded-[0.65rem] border border-line2 bg-card px-3 text-sm outline-none focus:border-accent" />
          <div className="flex justify-end gap-2"><Button onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={!value} loading={busy}>Save secret</Button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- 1. network ----------
export function NetworkTab() {
  const { state, simulateDrop, toast } = useTerminal();
  return (
    <div className="grid gap-5">
      <Section title="RPC" desc="Credentials never go in URLs. Put API keys in the RPC API key secret; the engine sends it as a header.">
        <TextField path="network.rpc_primary_url" label="Primary RPC URL" placeholder="https://…" mono />
        <SelectField path="network.commitment" label="Commitment" options={[{ value: 'processed', label: 'processed' }, { value: 'confirmed', label: 'confirmed' }, { value: 'finalized', label: 'finalized' }]} />
        <SecretField id="network.rpc_api_key" />
        <ListField path="network.rpc_backup_urls" label="Backup RPC URLs" hint="One per line, tried in order. Up to 4." placeholder="https://backup-1…" rows={3} />
      </Section>
      <Section title="Ingestion" desc="Account updates from Geyser and raw shreds from ShredStream.">
        <TextField path="network.geyser_grpc_url" label="Geyser gRPC endpoint" placeholder="https://…:443" mono />
        <SecretField id="network.geyser_token" />
        <NumField path="network.slot_clock_offset_ms" label="Slot-clock offset" unit="ms" hint="Correction applied to local slot timing (−2000 to 2000)." />
        <TextField path="network.shredstream_url" label="ShredStream endpoint" placeholder="grpc://…" mono />
        <SecretField id="network.shredstream_token" />
      </Section>
      <Section title="Connection test" desc="Test WebSocket telemetry reconnect behavior.">
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 xl:col-span-3">
          <Button icon={WifiOff} onClick={() => { simulateDrop(); toast('Simulated a dropped connection'); }} disabled={state.connection !== 'open'}>Simulate connection drop</Button>
          <span className="text-xs text-muted">Shows the reconnect banner and auto-reconnect with backoff.</span>
        </div>
      </Section>
    </div>
  );
}

// ---------- 2. wallets ----------
const NONCE_TONE = { ready: 'ok', in_use: 'info', low_balance: 'warn', missing: 'bad' } as const;

function NoncePool() {
  const { state } = useTerminal();
  const { run, busy } = useCommand();
  const { draft } = useForm();
  const nonces = state.config?.nonces ?? [];
  const target = draft.wallets.nonce_target_pool_size;
  const low = nonces.filter((n) => n.status === 'low_balance').length;
  const engineOnline = state.engineSource === 'bridge';
  return (
    <Section title="Durable nonce pool"
      desc={<>Pre-signed transactions use these accounts instead of a recent blockhash. <span className="text-fg">{nonces.filter((n) => n.status === 'ready').length}/{nonces.length}</span> ready · target {target}.</>}
      actions={<div className="flex flex-wrap gap-2">
        <Button size="sm" icon={RefreshCw} disabled={busy || !engineOnline} title={!engineOnline ? 'Connect the Rust engine to run nonce actions' : undefined} onClick={() => run({ type: 'nonce.check' }, 'Health check complete')}>Health check</Button>
        <Button size="sm" disabled={busy || !engineOnline || low === 0} onClick={() => run({ type: 'nonce.topup' }, `Topped up ${low} account${low === 1 ? '' : 's'}`)}>Top up{low ? ` (${low})` : ''}</Button>
        <Button size="sm" icon={Plus} disabled={busy || !engineOnline || nonces.length >= 32} onClick={() => run({ type: 'nonce.create', count: Math.max(1, target - nonces.length) }, 'Nonce account created')}>Create {Math.max(1, target - nonces.length)}</Button>
      </div>}>
      <ul className="grid gap-2 sm:col-span-2 sm:grid-cols-2 xl:col-span-3 xl:grid-cols-4">
        {nonces.map((n) => (
          <li key={n.pubkey} className="flex items-center justify-between gap-2 rounded-xl border border-line bg-card px-3 py-2">
            <span className="num truncate text-xs" title={n.pubkey}>{shortKey(n.pubkey, 6)}</span>
            <span className="flex items-center gap-1.5">
              {(n.status === 'in_use' || n.status === 'missing') && <Button size="sm" variant="ghost" disabled={busy} onClick={() => run({ type: 'nonce.advance', pubkey: n.pubkey }, 'Nonce advanced')}>Advance</Button>}
              <Badge tone={NONCE_TONE[n.status]}>{n.status.replace('_', ' ')}</Badge>
            </span>
          </li>
        ))}
        {nonces.length === 0 && <li className="text-sm text-muted">No nonce accounts yet.</li>}
      </ul>
      <ToggleField path="wallets.nonce_auto_create" label="Auto-create to target" desc="Create accounts when the pool drops below target." />
      <NumField path="wallets.nonce_target_pool_size" label="Target pool size" hint="1–32 accounts." />
      <NumField path="wallets.nonce_health_check_secs" label="Health-check interval" unit="s" />
      <NumField path="wallets.nonce_min_balance_sol" label="Top-up below" unit="SOL" hint="Rent-exempt minimum is ≈0.0015 SOL." />
      <ListField path="wallets.nonce_accounts" label="Nonce accounts" hint="Edit by hand, or use Create above. Saved with the rest of the config." rows={4} />
    </Section>
  );
}

export function WalletsTab() {
  return (
    <div className="grid gap-5">
      <Section title="Hot trading wallet" desc="The signer key never passes through this page. It lives in the engine’s encrypted keystore or a remote signer.">
        <TextField path="wallets.hot_wallet_pubkey" label="Hot wallet public key" mono />
        <SelectField path="wallets.signer_source" label="Signer" options={[{ value: 'encrypted_keystore', label: 'Encrypted keystore (engine host)' }, { value: 'remote_signer', label: 'Remote signer' }]} />
        <SecretField id="wallets.hot_wallet_keypair" />
        <TextField path="wallets.wsol_vault_ata" label="WSOL vault ATA" mono hint="Token account holding the WSOL trading bankroll." />
        <NumField path="wallets.max_hot_wallet_sol" label="Max hot-wallet balance" unit="SOL" hint="Excess is swept to treasury; the engine refuses to run above it." />
      </Section>
      <NoncePool />
    </div>
  );
}

// ---------- 3. strategy ----------
export function StrategyTab() {
  const { draft } = useForm();
  return (
    <div className="grid gap-5">
      <Section title="Modes" desc="Copy-trading mode can be switched live.">
        <ToggleField path="strategy.modes.kol_backrun" label="KOL copy-trade backrun" desc="Buy in the same slot after a watched wallet’s buy lands." />
      </Section>
      <Section title="Buy sizing & guards">
        <NumField path="strategy.default_buy_sol" label="Default buy size" unit="SOL" />
        <NumField path="strategy.min_buy_sol" label="Min buy size" unit="SOL" />
        <NumField path="strategy.max_buy_sol" label="Max buy size" unit="SOL" />
        <NumField path="strategy.max_curve_reserve_sol" label="Max bonding-curve reserve" unit="SOL" hint="Skip pools that already hold more than this." />
        <NumField path="strategy.slippage_bps" label="Buy slippage" unit="bps" hint={`${(draft.strategy.slippage_bps / 100 || 0).toFixed(2)}%`} />
        <NumField path="strategy.default_kol_margin_sol" label="Default KOL balance-drop margin" unit="SOL" hint="Default 0.02 SOL. Per-wallet values on the watchlist override it." />
        <SlotRangeField path="strategy.buy_slot_ttl" label="Buy slot TTL" hint="Reject buys landing after trigger slot + max. Default +0 to +4." />
      </Section>
    </div>
  );
}

// ---------- 4. landers ----------
function ProviderCard({ id }: { id: LanderKey }) {
  const f = useForm();
  const [open, setOpen] = useState(false);
  const base = `landers.providers.${id}`;
  const p = f.draft.landers.providers[id];
  const errs = Object.keys(f.errors).filter((k) => k.startsWith(base + '.')).length;
  return (
    <div className={cx('rounded-xl border bg-card', errs ? 'border-rose-400/40' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <Toggle checked={p.enabled} label={`${LANDER_LABEL[id]} enabled`} onChange={(v) => f.set(`${base}.enabled`, v)} disabled={f.disabled} />
        <span className="min-w-36 flex-1 font-medium">{LANDER_LABEL[id]}</span>
        <span className="num text-xs text-fg2">{p.fanout} tx · {fmtSol(p.min_tip_sol, 4)}–{fmtSol(p.max_tip_sol, 4)} SOL</span>
        {errs > 0 && <Badge tone="bad">{errs} error{errs > 1 ? 's' : ''}</Badge>}
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Edit'}</Button>
      </div>
      {open && (
        <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="sm:col-span-2"><TextField path={`${base}.endpoint_url`} label="Endpoint URL" mono /></div>
          <NumField path={`${base}.fanout`} label="Burst fan-out" unit="txs" />
          {id !== 'tpu' ? <SecretField id={`landers.${id}.auth_token`} /> : <div />}
          <NumField path={`${base}.min_tip_sol`} label="Min tip" unit="SOL" />
          <NumField path={`${base}.max_tip_sol`} label="Max tip" unit="SOL" />
          {id !== 'tpu' && <div className="sm:col-span-2 xl:col-span-4"><ListField path={`${base}.tip_accounts`} label="Tip wallet rotation" hint="Rotated per transaction. One public key per line." rows={3} /></div>}
        </div>
      )}
    </div>
  );
}

export function LandersTab() {
  const f = useForm();
  const on = LANDER_IDS.filter((id) => f.draft.landers.providers[id].enabled);
  const fan = on.reduce((a, id) => a + f.draft.landers.providers[id].fanout, 0);
  return (
    <div className="grid gap-5">
      <Section title="Providers" error={f.errors['landers.providers']}
        desc={<>{on.length} enabled · total fan-out <span className={cx('num', fan > 128 ? 'text-rose-300' : 'text-fg')}>{fan}</span>/128 txs per opportunity. Only the winning transaction pays its tip.</>}>
        <div className="grid gap-2.5 sm:col-span-2 xl:col-span-3">{LANDER_IDS.map((id) => <ProviderCard key={id} id={id} />)}</div>
      </Section>
      <Section title="Transaction config" desc="Solana v1 transactionConfig applied to every burst.">
        <SelectField path="landers.tx.version" label="Transaction version" options={[{ value: 'v1', label: 'v1 (transactionConfig)' }, { value: 'v0', label: 'v0 (lookup tables)' }, { value: 'legacy', label: 'legacy' }]} />
        <NumField path="landers.tx.compute_unit_limit" label="computeUnitLimit" unit="CU" />
        <NumField path="landers.tx.loaded_accounts_data_size_limit" label="loadedAccountsDataSizeLimit" unit="bytes" />
        <NumField path="landers.tx.priority_fee_lamports" label="priorityFee" unit="lamports" hint={`${fmtSol((f.draft.landers.tx.priority_fee_lamports || 0) / 1e9, 6)} SOL`} />
        <NumField path="landers.max_hourly_burn_sol" label="Max hourly gas + tip burn" unit="SOL" hint="Engine pauses itself when the rolling hour exceeds this." />
      </Section>
    </div>
  );
}

// ---------- 5. exits ----------
function Ladder() {
  const f = useForm();
  const steps = f.draft.exits.ladder;
  const setSteps = (next: BotConfig['exits']['ladder']) => f.set('exits.ladder', next);
  return (
    <Section title="Staged take-profit ladder" error={f.errors['exits.ladder']} desc="Each step sells a share of what is left when its trigger hits."
      actions={<Button size="sm" icon={Plus} disabled={f.disabled || steps.length >= 8} onClick={() => setSteps([...steps, { sell_pct: 100, trigger: { kind: 'time_secs', value: 1800 } }])}>Add step</Button>}>
      <ol className="grid gap-2 sm:col-span-2 xl:col-span-3">
        {steps.length === 0 && <li className="text-sm text-muted">No ladder steps. Positions exit only by stop, trailing stop or manual sell.</li>}
        {steps.map((s, i) => (
          <li key={i} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-xl border border-line bg-card p-3 sm:grid-cols-[auto_8rem_11rem_13rem_1fr]">
            <span className="num mt-2 w-6 text-sm text-muted">{i + 1}.</span>
            <NumField path={`exits.ladder[${i}].sell_pct`} label="Sell" unit="%" />
            <div className="flex flex-col gap-1.5">
              <label className="text-[0.8rem] font-medium text-fg2" htmlFor={`trig-${i}`}>Trigger</label>
              <select id={`trig-${i}`} value={s.trigger.kind} disabled={f.disabled}
                onChange={(e) => f.set(`exits.ladder[${i}].trigger`, e.target.value === 'pnl_multiple' ? { kind: 'pnl_multiple', value: 2 } : { kind: 'time_secs', value: 1800 })}
                className="h-9 rounded-[0.65rem] border border-line2 bg-card px-2.5 text-sm outline-none focus:border-accent">
                <option value="pnl_multiple">PnL multiple</option><option value="time_secs">Time held</option>
              </select>
            </div>
            <NumField path={`exits.ladder[${i}].trigger.value`} label={s.trigger.kind === 'pnl_multiple' ? 'At' : 'After'} unit={s.trigger.kind === 'pnl_multiple' ? '× entry' : 's'} />
            <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove step ${i + 1}`} className="mt-6 justify-self-end hover:text-rose-300" onClick={() => setSteps(steps.filter((_, j) => j !== i))} />
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function ExitsTab() {
  return (
    <div className="grid gap-5">
      <Section title="Instant take-profit" desc="Clip sold in the same slot as the buy, priced on-chain as a share of the live balance.">
        <NumField path="exits.instant_tp_pct" label="Same-slot TP clip" unit="%" hint="Default 25%. 0 turns it off." />
      </Section>
      <Ladder />
      <Section title="Risk controls">
        <NumField path="exits.stop_loss_pct" label="Stop-loss" unit="% below entry" nullable />
        <NumField path="exits.trailing_stop_pct" label="Trailing stop" unit="% from peak" nullable />
        <SlotRangeField path="exits.sell_slot_ttl" label="Sell slot TTL" hint="Lighthouse slot assertion on sells. Default +7 to +9." />
        <ToggleField path="exits.curve_floor.enabled" label="Bonding-curve reserve floor check" desc="Lighthouse assertion on real_sol_reserves before selling." />
        <NumField path="exits.curve_floor.min_real_sol_reserves_sol" label="Min real_sol_reserves" unit="SOL" />
        <ToggleField path="exits.auto_close_account" label="Auto CloseAccount on full exit" desc="Reclaims ≈0.00204 SOL rent per closed token account." />
      </Section>
    </div>
  );
}

// ---------- 6. treasury ----------
export function TreasuryTab() {
  const { draft } = useForm();
  const on = draft.treasury.sweep_enabled;
  return (
    <div className="grid gap-5">
      <Section title="WSOL → USDC auto-sweep" desc="Moves trading profit out of the WSOL vault in fixed clips.">
        <ToggleField path="treasury.sweep_enabled" label="Enable auto-sweep" />
        <NumField path="treasury.trigger_wsol_threshold" label="Sweep when WSOL vault above" unit="WSOL" />
        <NumField path="treasury.clip_wsol" label="Clip size" unit="WSOL" hint="Default 20.0 WSOL per sweep." />
        <TextField path="treasury.target_mint" label="Target mint" mono hint="USDC by default." />
        <SelectField path="treasury.route" label="Route" options={[{ value: 'jupiter_v6', label: 'Jupiter V6 (incl. ZeroFi)' }]} />
        <NumField path="treasury.slippage_bps" label="Swap slippage" unit="bps" />
        <NumField path="treasury.max_priority_fee_lamports" label="Max priority fee" unit="lamports" />
      </Section>
      {!on && <p className="text-sm text-muted">Auto-sweep is off. WSOL stays in the vault until you move it.</p>}
    </div>
  );
}

// ---------- 7. security ----------
export function SecurityTab() {
  const { state, auth, toast } = useTerminal();
  const setSecretCount = Object.values(state.config?.secrets ?? {}).filter((s) => s.set).length;
  return (
    <div className="grid gap-5">
      <Section title="Two-step authentication (2FA)" desc="Require a 6-digit authenticator code (Google Authenticator / Authy / 1Password) in addition to your operator token.">
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-card px-4 py-3.5 sm:col-span-2 lg:col-span-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-line2 bg-raised text-fg2">
              <Lock className="size-4" aria-hidden />
            </span>
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-fg">
                Authenticator App (TOTP)
                <Badge tone="neutral">Not enabled</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Protects terminal login, Live Mode activation, and secret changes with a time-based 6-digit code.
              </p>
            </div>
          </div>
          <Button variant="primary" onClick={() => toast('2FA TOTP enrollment ready to wire on control plane', 'info')}>
            Set up 2FA
          </Button>
        </div>
      </Section>

      <Section title="Access & encryption" desc="Current control-plane authentication, encrypted secret vault, and audit trail.">
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <div className="text-xs text-muted">Operator authentication</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-fg">
            scrypt token + JWT <span className="text-xs font-medium text-emerald-400">Active</span>
          </div>
          <p className="mt-1 text-xs text-muted">Rate-limited login with revocable 12h session tokens.</p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <div className="text-xs text-muted">Encrypted secrets vault</div>
          <div className="mt-1 flex items-center gap-2 text-sm font-semibold text-fg">
            {setSecretCount} secret{setSecretCount === 1 ? '' : 's'} stored <span className="text-xs font-medium text-emerald-400">Encrypted</span>
          </div>
          <p className="mt-1 text-xs text-muted">Write-only at rest (ChaCha20-Poly1305), never returned to the browser.</p>
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <div className="text-xs text-muted">Audit trail</div>
          <div className="mt-1 text-sm font-semibold text-fg">SQLite action log</div>
          <p className="mt-1 text-xs text-muted">
            <Link href="/diagnostics" className="text-accent hover:underline">View recent logins, config edits &amp; sells →</Link>
          </p>
        </div>
      </Section>

      <Section title="Session" desc="Manage your current browser session on this control plane.">
        <div className="flex flex-wrap items-center justify-between gap-3 sm:col-span-2 lg:col-span-3">
          <p className="text-xs text-muted">Signing out revokes your active JWT immediately on the server.</p>
          <Button variant="danger" icon={Power} onClick={() => void auth.logout()}>Sign out session</Button>
        </div>
      </Section>
    </div>
  );
}

export { getAt, RestartTag };

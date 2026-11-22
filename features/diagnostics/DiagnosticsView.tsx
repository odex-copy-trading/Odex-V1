'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Activity, Check, RefreshCw, TriangleAlert, WifiOff } from '@/components/icons';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Td, Th, cx } from '@/components/ui';
import { SECRETS, validateConfig } from '@/lib/config/schema';
import { fmtAgo, fmtClock } from '@/lib/format';
import { API_URL, useTerminal } from '@/lib/store';

interface HealthCheck {
  ok: boolean;
  latencyMs: number;
  engineSource?: string;
  uptimeSec?: number;
  error?: string;
}

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  ip: string | null;
  action: string;
  target: string | null;
}

interface ClientError {
  id: number;
  ts: number;
  source: string;
  message: string;
}

type CheckStatus = 'ok' | 'warn' | 'bad';

export function DiagnosticsView() {
  const { state, simulateDrop, toast } = useTerminal();
  const [running, setRunning] = useState(false);
  const [health, setHealth] = useState<HealthCheck | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [clientErrors, setClientErrors] = useState<ClientError[]>([]);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);

  // Capture any uncaught browser runtime errors / unhandled rejections
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      setClientErrors((prev) => [
        { id: Date.now() + Math.random(), ts: Date.now(), source: ev.filename ? `${ev.filename}:${ev.lineno}` : 'window.error', message: ev.message || 'Unknown error' },
        ...prev.slice(0, 29),
      ]);
    };
    const onRej = (ev: PromiseRejectionEvent) => {
      const msg = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
      setClientErrors((prev) => [
        { id: Date.now() + Math.random(), ts: Date.now(), source: 'unhandledrejection', message: msg },
        ...prev.slice(0, 29),
      ]);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, []);

  const runDiagnostic = useCallback(async () => {
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await fetch(`${API_URL}/api/health`);
      const latencyMs = Math.round(performance.now() - t0);
      const body = await r.json().catch(() => ({})) as { ok?: boolean; engineSource?: string; uptimeSec?: number; error?: string };
      setHealth({ ok: r.ok && !!body.ok, latencyMs, engineSource: body.engineSource, uptimeSec: body.uptimeSec, error: body.error });
    } catch (e) {
      setHealth({ ok: false, latencyMs: Math.round(performance.now() - t0), error: (e as Error).message });
    }

    try {
      const jwt = sessionStorage.getItem('whal.jwt');
      if (jwt) {
        const ar = await fetch(`${API_URL}/api/audit?limit=25`, { headers: { Authorization: `Bearer ${jwt}` } });
        if (ar.ok) {
          const data = await ar.json() as { items?: AuditRow[] };
          setAudit(data.items ?? []);
        }
      }
    } catch { /* ignore */ }

    setLastRunAt(Date.now());
    setRunning(false);
  }, []);

  useEffect(() => { void runDiagnostic(); }, [runDiagnostic]);

  const configValidation = useMemo(() => {
    if (!state.config) return null;
    const v = validateConfig(state.config.config);
    return v.ok ? [] : Object.entries(v.errors);
  }, [state.config]);

  const checks: { name: string; status: CheckStatus; detail: string; href?: string }[] = useMemo(() => {
    const out: { name: string; status: CheckStatus; detail: string; href?: string }[] = [];

    out.push({
      name: 'Control plane API',
      status: !health ? 'warn' : health.ok ? 'ok' : 'bad',
      detail: !health ? 'Checking…' : health.ok ? `HTTP 200 · ${health.latencyMs} ms · uptime ${health.uptimeSec ?? 0}s` : (health.error || 'Unreachable'),
    });

    out.push({
      name: 'WebSocket telemetry',
      status: state.connection === 'open' ? 'ok' : state.connection === 'connecting' ? 'warn' : 'bad',
      detail: state.connection === 'open'
        ? `Connected${state.lastMessageAt ? ` · last event ${fmtAgo(state.lastMessageAt)} ago` : ''}`
        : `State: ${state.connection}`,
    });

    const engineOnline = state.engineSource === 'bridge';
    out.push({
      name: 'Rust trading engine bridge',
      status: engineOnline ? 'ok' : 'warn',
      detail: engineOnline
        ? `Connected · status ${state.engine.status} · slot ${state.chain.slot}`
        : 'Offline — waiting for whal-engine on /internal/engine',
    });

    const cfgErrCount = configValidation?.length ?? 0;
    out.push({
      name: 'Configuration schema',
      status: !configValidation ? 'warn' : cfgErrCount === 0 ? 'ok' : 'warn',
      detail: !configValidation
        ? 'Loading config…'
        : cfgErrCount === 0
          ? `v${state.config?.version} valid · ${state.config?.pendingRestart.length ?? 0} pending restart`
          : `${cfgErrCount} required field${cfgErrCount === 1 ? '' : 's'} to complete`,
      href: cfgErrCount > 0 ? '/settings' : undefined,
    });

    const nonces = state.config?.nonces ?? [];
    const readyNonces = nonces.filter((n) => n.status === 'ready').length;
    out.push({
      name: 'Durable nonce pool',
      status: nonces.length === 0 ? 'warn' : readyNonces === nonces.length ? 'ok' : 'warn',
      detail: nonces.length === 0 ? 'No nonce accounts configured yet' : `${readyNonces}/${nonces.length} ready`,
      href: '/settings',
    });

    out.push({
      name: 'Browser runtime errors',
      status: clientErrors.length === 0 ? 'ok' : 'bad',
      detail: clientErrors.length === 0 ? '0 uncaught exceptions this session' : `${clientErrors.length} error(s) captured`,
    });

    return out;
  }, [health, state, configValidation, clientErrors.length]);

  const badCount = checks.filter((c) => c.status === 'bad').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;

  return (
    <div className="mx-auto max-w-[96rem]">
      <PageHeader
        title="Bug & system diagnostics"
        sub={lastRunAt ? `Last checked ${fmtAgo(lastRunAt)} ago · ${badCount} critical · ${warnCount} warnings` : 'Running live health checks…'}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button icon={WifiOff} onClick={() => { simulateDrop(); toast('Simulated WS disconnect'); }} disabled={state.connection !== 'open'}>Test WS reconnect</Button>
            <Button variant="primary" icon={RefreshCw} loading={running} onClick={() => void runDiagnostic()}>Run diagnostic</Button>
          </div>
        }
      />

      {/* Health checklist */}
      <Card className="mb-4">
        <CardHeader title="Live system checks" meta={<span>API, WebSocket, Rust engine bridge, config validation, nonces, and client runtime</span>} />
        <ul className="divide-y divide-line">
          {checks.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-sm">
              <div className="flex items-center gap-3">
                {c.status === 'ok'
                  ? <Check className="size-4 text-emerald-400" aria-hidden />
                  : <TriangleAlert className={cx('size-4', c.status === 'bad' ? 'text-rose-400' : 'text-amber-300')} aria-hidden />}
                <span className="font-medium">{c.name}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-fg2">{c.detail}</span>
                {c.href && <Link href={c.href} className="text-xs font-medium text-accent hover:underline">Fix</Link>}
                <Badge tone={c.status}>{c.status === 'ok' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL'}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Config validation issues + secrets */}
        <Card>
          <CardHeader title="Config & secrets readiness" meta={<span>Live Step 2 schema validation & write-only secret store</span>} />
          <div className="space-y-4 p-5 text-sm">
            {configValidation && configValidation.length > 0 ? (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-300">Missing / invalid fields ({configValidation.length})</div>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {configValidation.map(([path, msg]) => (
                    <li key={path} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                      <code className="num text-fg">{path}</code>
                      <span className="text-rose-300">{msg}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs text-emerald-300">All configuration fields pass schema validation.</p>
            )}

            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Encrypted secrets</div>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {SECRETS.slice(0, 8).map((s) => {
                  const st = state.config?.secrets[s.id];
                  return (
                    <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2 text-xs">
                      <span className="truncate text-fg2">{s.label}</span>
                      <Badge tone={st?.set ? 'ok' : 'neutral'}>{st?.set ? 'Set' : 'Unset'}</Badge>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </Card>

        {/* Browser runtime errors + recent audit log */}
        <Card>
          <CardHeader title="Recent control-plane audit log" meta={<span>Persisted SQLite trail of logins, config changes, KOL edits & sells</span>} />
          {audit.length === 0 ? (
            <EmptyState icon={Activity} title="No audit events yet">Control-plane actions will appear here.</EmptyState>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-[0.8rem]">
                <thead className="sticky top-0 bg-panel"><tr><Th>Time</Th><Th>Action</Th><Th>Target</Th><Th>Actor</Th></tr></thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id} className="hover:bg-card">
                      <Td mono className="text-fg2">{fmtClock(a.ts)}</Td>
                      <Td mono>{a.action}</Td>
                      <Td mono className="text-fg2">{a.target ?? '—'}</Td>
                      <Td className="text-muted">{a.actor}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {clientErrors.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Captured browser runtime errors" actions={<Button size="sm" onClick={() => setClientErrors([])}>Clear</Button>} />
          <ul className="divide-y divide-line">
            {clientErrors.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-xs">
                <span className="text-rose-300">{e.message}</span>
                <span className="num text-muted">{e.source} · {fmtClock(e.ts)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Radar, RefreshCw, TriangleAlert } from '@/components/icons';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Td, Th, cx } from '@/components/ui';
import { fmtClock } from '@/lib/format';
import { API_URL, useTerminal } from '@/lib/store';
import type { ObserverFinding, ObserverReport, TradeStats } from '@/server/observer';

function fmtSigned(n: number, suffix = ''): string {
  const s = n > 0 ? `+${n}` : `${n}`;
  return `${s}${suffix}`;
}

function severityBadge(sev: ObserverFinding['severity']): 'bad' | 'warn' | 'ok' | 'neutral' {
  if (sev === 'critical') return 'bad';
  if (sev === 'warn') return 'warn';
  if (sev === 'good') return 'ok';
  return 'neutral';
}

function StatsRow({ label, s }: { label: string; s: TradeStats }) {
  return (
    <tr className="border-t border-line/70">
      <Td className="font-medium text-fg">{label}</Td>
      <Td className="text-right font-mono">{s.trades}</Td>
      <Td className="text-right font-mono">{s.winRatePct.toFixed(1)}%</Td>
      <Td className={cx('text-right font-mono', s.netSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
        {fmtSigned(+s.netSol.toFixed(4), ' SOL')}
      </Td>
      <Td className="text-right font-mono text-emerald-400">+{s.avgWinPct.toFixed(1)}%</Td>
      <Td className="text-right font-mono text-rose-400">{s.avgLossPct.toFixed(1)}%</Td>
      <Td className="text-right font-mono">{s.profitFactor.toFixed(2)}</Td>
      <Td className={cx('text-right font-mono', s.kolNetSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
        {s.kolTrades} ({fmtSigned(+s.kolNetSol.toFixed(3))})
      </Td>
    </tr>
  );
}

export function ObserverView() {
  const { toast } = useTerminal();
  const [report, setReport] = useState<ObserverReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const jwt = sessionStorage.getItem('whal.jwt');
      const r = await fetch(`${API_URL}/api/observer/report`, {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as ObserverReport;
      setReport(data);
    } catch (e) {
      setError((e as Error).message || 'Failed to load observer report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchReport();
    const id = setInterval(() => void fetchReport(), 30_000);
    return () => clearInterval(id);
  }, [fetchReport]);

  const copyPlainText = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.plainTextSummary);
      setCopied(true);
      toast('Copied live quant report to clipboard', 'ok');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not copy report', 'error');
    }
  };

  const slotMeasured = report
    ? report.slotDistribution.slot0 + report.slotDistribution.slot1 + report.slotDistribution.slot2Plus
    : 0;
  const slot0Pct = report && slotMeasured > 0
    ? Math.round((report.slotDistribution.slot0 * 100) / slotMeasured)
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
      <PageHeader
        title="Quant Observer Agent"
        sub={
          report
            ? `Deterministic real-time bot auditor · Config v${report.configVersion} · Updated ${fmtClock(report.generatedAt)} (auto-refreshes every 30s)`
            : 'Deterministic real-time quant observer analyzing live fills, Slot +0 landing, KOLs, and exit math.'
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={copyPlainText} disabled={!report}>
              {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
              Copy TXT Report
            </Button>
            <Button onClick={() => void fetchReport()} disabled={loading}>
              <RefreshCw className={cx('size-4', loading && 'animate-spin')} />
              Refresh Audit
            </Button>
          </div>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-400/35 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          <TriangleAlert className="size-4 shrink-0" />
          Failed to fetch observer report: {error}
        </div>
      )}

      {!report ? (
        <Card>
          <EmptyState
            icon={Radar}
            title={loading ? 'Running live quant audit…' : 'No observer report loaded yet'}
          >
            Click Refresh Audit to analyze all live trades, paper benchmarks, landing slots, landers, and KOL wallets.
          </EmptyState>
        </Card>
      ) : (
        <>
          {/* Top KPI Summary */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <div className="text-xs text-muted">Live Expectancy (Last 20)</div>
              <div className={cx('mt-1 font-mono text-2xl font-semibold', report.liveRecent20.expectancySol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {fmtSigned(report.liveRecent20.expectancySol, ' SOL')}
              </div>
              <div className="mt-1 text-xs text-muted">
                WR {report.liveRecent20.winRatePct}% · PF {report.liveRecent20.profitFactor}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted">Verified Slot +0 Rate</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-fg">
                {slot0Pct !== null ? `${slot0Pct}%` : 'n/a'}
              </div>
              <div className="mt-1 text-xs text-muted">
                +0: {report.slotDistribution.slot0} · +1: {report.slotDistribution.slot1} · +2+: {report.slotDistribution.slot2Plus}
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted">Round-Trip Fee + Tip Drag</div>
              <div className={cx('mt-1 font-mono text-2xl font-semibold', report.tipMath.roundTripDragPct <= 4.2 ? 'text-emerald-400' : 'text-amber-400')}>
                {report.tipMath.roundTripDragPct}%
              </div>
              <div className="mt-1 text-xs text-muted">
                Buy {report.tipMath.buyTipSol} · Sell {report.tipMath.sellTipSol} SOL ({report.tipMath.enabledLanders} landers)
              </div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted">Hot Wallet &amp; Engine</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-fg">
                {report.walletSol.toFixed(3)} SOL
              </div>
              <div className="mt-1 text-xs text-muted">
                Status: {report.engineStatus} · TTL +{report.tipMath.buySlotTtlMax} · Slip {(report.tipMath.slippageBps / 100).toFixed(0)}%
              </div>
            </Card>
          </div>

          {/* Priority-Ranked Actionable Findings */}
          <Card>
            <CardHeader
              title="Priority-Ranked Recommendations"
              meta="Pure math findings sorted by impact score (1–10) — zero guesswork"
              actions={<Badge tone="neutral">{report.findings.length} checks</Badge>}
            />
            <div className="divide-y divide-line/70">
              {report.findings.map((f) => (
                <div key={f.id} className="space-y-1.5 px-4 py-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={severityBadge(f.severity)}>{f.severity.toUpperCase()}</Badge>
                    <Badge tone="neutral">{f.category}</Badge>
                    <span className="font-mono text-xs text-muted">Impact {f.impactScore}/10</span>
                    <span className="text-sm font-medium text-fg">{f.title}</span>
                  </div>
                  <p className="text-xs text-muted">{f.evidence}</p>
                  <p className="text-xs text-fg">
                    <span className="font-medium text-emerald-400">Action:</span> {f.action}
                  </p>
                </div>
              ))}
            </div>
          </Card>

          {/* Live vs Paper Quant Benchmark */}
          <Card>
            <CardHeader
              title="Live vs Paper Quant Comparison"
              meta="Direct apples-to-apples performance split across Launch & KOL engines"
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted">
                    <Th>Cohort</Th>
                    <Th className="text-right">Trades</Th>
                    <Th className="text-right">Win Rate</Th>
                    <Th className="text-right">Net SOL</Th>
                    <Th className="text-right">Avg Win</Th>
                    <Th className="text-right">Avg Loss</Th>
                    <Th className="text-right">PF</Th>
                    <Th className="text-right">KOL Trades (SOL)</Th>
                  </tr>
                </thead>
                <tbody>
                  <StatsRow label="Live · Last 20" s={report.liveRecent20} />
                  <StatsRow label="Live · All-Time" s={report.liveAll} />
                  <StatsRow label="Paper · Last 100" s={report.paperRecent100} />
                  <StatsRow label="Paper · All-Time ($100→$4.5k)" s={report.paperAll} />
                </tbody>
              </table>
            </div>
          </Card>

          {/* Two-column: Exit Attribution + Lander Share */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Exit Machine Attribution" meta="Which exit rules generate profit vs bleed" />
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-muted">
                      <Th>Exit Reason</Th>
                      <Th className="text-right">Trades</Th>
                      <Th className="text-right">WR</Th>
                      <Th className="text-right">Net SOL</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.exitAttribution.map((e) => (
                      <tr key={e.reason} className="border-t border-line/70">
                        <Td className="text-fg">{e.reason}</Td>
                        <Td className="text-right font-mono">{e.trades}</Td>
                        <Td className="text-right font-mono">{e.winRatePct}%</Td>
                        <Td className={cx('text-right font-mono', e.netSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {fmtSigned(e.netSol, ' SOL')}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader title="Enabled KOL Watchlist Audit" meta="Sizing safety vs wallet balance + historical PnL" />
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-muted">
                      <Th>KOL</Th>
                      <Th className="text-right">Buy Size</Th>
                      <Th className="text-right">Max Curve</Th>
                      <Th className="text-right">Paper (SOL)</Th>
                      <Th className="text-right">Live (SOL)</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.kolAudit.map((k) => (
                      <tr key={k.id} className="border-t border-line/70">
                        <Td className="text-fg">
                          {k.label}
                          {k.oversizedForWallet && <Badge tone="bad" className="ml-1.5">Oversized</Badge>}
                        </Td>
                        <Td className="text-right font-mono">{k.buySizeSol} SOL</Td>
                        <Td className="text-right font-mono">{k.maxCurveSol} vSOL</Td>
                        <Td className={cx('text-right font-mono', k.paperNetSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {k.paperTrades} ({fmtSigned(k.paperNetSol)})
                        </Td>
                        <Td className={cx('text-right font-mono', k.liveNetSol >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                          {k.liveTrades} ({fmtSigned(k.liveNetSol)})
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

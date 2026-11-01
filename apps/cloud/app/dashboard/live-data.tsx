'use client';

import { useEffect, useState } from 'react';
import type { ReportRow } from '@adport/core';
import { Empty, Metric, Provider, formatMoney, formatNumber } from '@/components/ui';
import { Select } from '@/components/select';
import type { DashboardReportSummary } from '@/lib/report-summary';

interface Summary {
  rows: ReportRow[];
  summary?: DashboardReportSummary;
  truncated?: boolean;
  warnings?: Array<{ provider: string; message: string }>;
}

export function LiveData({ organizationId, connected }: { organizationId: string; connected: boolean }) {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState<string>();
  const [groupKey, setGroupKey] = useState('');
  useEffect(() => {
    setSummary(undefined); setError(undefined);
    if (!connected) return;
    const controller = new AbortController();
    void fetch(`/api/dashboard/summary?organization_id=${organizationId}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json() as Summary & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Unable to load campaign data.');
        if (!controller.signal.aborted) setSummary(body);
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load campaign data.');
      });
    return () => controller.abort();
  }, [connected, organizationId]);

  const groups = summary?.summary?.groups ?? [];
  const group = groups.find(item => item.key === groupKey) ?? groups[0];
  const rows = (summary?.rows ?? []).filter(row => !group || (group.currency ? row.currency === group.currency : group.accounts.some(account => account.provider === row.provider && account.account_id === row.accountId)));
  const totals = group?.metrics;
  const loading = connected && !summary && !error;
  const number = (value: number | null | undefined) => loading ? '…' : value == null ? '—' : formatNumber(value);
  const spend = totals?.spend == null ? '—' : group?.currency ? formatMoney(totals.spend, group.currency) : formatNumber(totals.spend);

  return <>
    {error ? <div className="error-callout" role="alert">{error}</div> : null}
    {summary?.warnings?.map(warning => <div className="error-callout" role="alert" key={`${warning.provider}:${warning.message}`}>{warning.message}</div>)}
    <div className="performance-toolbar"><span>Last 7 days</span>
      {groups.length > 1 ? <Select aria-label="Performance currency or account" value={group?.key} onValueChange={setGroupKey} options={groups.map(item => ({ value: item.key, label: item.currency ?? `Unlabelled · ${item.accounts[0]?.account_id ?? 'account'}` }))} /> : group?.currency ? <span className="card-note">{group.currency}</span> : group ? <span className="status warn">Currency unavailable</span> : null}
      {summary?.truncated || summary?.summary?.complete === false ? <span className="status warn">Partial results</span> : null}
    </div>
    <section className="metrics" aria-label="Performance summary" aria-busy={loading}>
      <Metric label="Spend" value={loading ? '…' : spend} foot="Spend in the selected currency. Unlabelled currencies stay separate by account; no exchange-rate conversion is applied." />
      <Metric label="Clicks" value={number(totals?.clicks)} foot={`${number(totals?.impressions)} impressions in this group. Figures cover the last seven completed days.`} />
      <Metric label="Conversions" value={number(totals?.conversions)} foot="Reported by each advertising platform. Conversion definitions and attribution can differ; this is not a deduplicated customer count." />
      <Metric label="ROAS" value={totals?.roas == null ? loading ? '…' : '—' : `${formatNumber(totals.roas)}×`} foot="Conversion value divided by spend in this currency group. Uses spend-weighted reported ROAS when conversion value is unavailable. A dash means the ratio cannot be calculated." />
    </section>
    <section className="card">
      <div className="card-head"><h2>Campaign activity</h2><span className="card-note">{rows.length ? `${rows.length} campaigns` : 'Last 7 days'}</span></div>
      {loading ? <div className="card-body">{[0, 1, 2, 3].map(i => <div className="skeleton-line" style={{ width: '100%', height: '.7rem', marginBottom: i === 3 ? 0 : '1rem', opacity: 1 - i * .2 }} key={i} />)}</div>
        : rows.length === 0 ? <Empty title="No campaign activity yet" copy="Enabled accounts will appear here when they return campaign activity." />
        : <div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Platform</th><th>Status</th><th className="numeric">Spend</th><th className="numeric">Clicks</th><th className="numeric">Conv.</th><th className="numeric">ROAS</th></tr></thead><tbody>
          {rows.slice(0, 12).map(row => <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
            <td><strong>{row.entity.name || row.entity.id}</strong><div className="cell-sub">{row.accountId}</div></td><td><Provider name={row.provider} /></td>
            <td>{row.entity.status ? <span className={`status ${/paused|disabled|removed/i.test(row.entity.status) ? 'neutral' : ''}`}>{row.entity.status}</span> : '—'}</td>
            <td className="numeric">{row.metrics.spend == null ? '—' : row.currency ? formatMoney(row.metrics.spend, row.currency) : formatNumber(row.metrics.spend)}</td>
            <td className="numeric">{number(row.metrics.clicks)}</td><td className="numeric">{number(row.metrics.conversions)}</td><td className="numeric">{row.metrics.roas == null ? '—' : `${formatNumber(row.metrics.roas)}×`}</td>
          </tr>)}
        </tbody></table></div>}
    </section>
  </>;
}

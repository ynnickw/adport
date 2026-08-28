'use client';

import { useEffect, useState } from 'react';
import { Empty, Metric, Provider, formatNumber } from '@/components/ui';

interface Summary {
  rows: Array<{ provider: string; accountId: string; entity: { id: string; name: string; status?: string }; metrics: Record<string, number> }>;
  truncated?: boolean;
  warnings?: Array<{ provider: string; message: string }>;
}

/**
 * Live seven-day read across every connected provider. Rendered client-side so
 * the overview shell paints immediately while provider APIs respond.
 */
export function LiveData({ organizationId, connected }: { organizationId: string; connected: boolean }) {
  const [summary, setSummary] = useState<Summary>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!connected) return;
    void fetch(`/api/dashboard/summary?organization_id=${organizationId}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as Summary & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Unable to load provider data.');
        setSummary(body);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [connected, organizationId]);

  const rows = summary?.rows ?? [];
  const totals = rows.reduce((sum, row) => ({
    spend: sum.spend + (row.metrics.spend ?? 0),
    impressions: sum.impressions + (row.metrics.impressions ?? 0),
    clicks: sum.clicks + (row.metrics.clicks ?? 0),
    conversions: sum.conversions + (row.metrics.conversions ?? 0),
    value: sum.value + (row.metrics.conversion_value ?? 0),
  }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 });
  const roas = totals.spend > 0 ? totals.value / totals.spend : 0;
  const loading = connected && !summary && !error;

  return (
    <>
      {error ? <div className="error-callout">Provider read failed: {error}</div> : null}
      {summary?.warnings?.map((warning) => (
        <div className="error-callout" key={`${warning.provider}:${warning.message}`}>Partial provider read: {warning.message}</div>
      ))}
      <section className="metrics" aria-label="Performance summary" aria-busy={loading}>
        <Metric label="Spend" value={loading ? '…' : formatNumber(totals.spend)} foot="Last 7 days · account currencies" />
        <Metric label="Clicks" value={loading ? '…' : formatNumber(totals.clicks)} foot={loading ? 'Loading' : `${formatNumber(totals.impressions)} impressions`} />
        <Metric label="Conversions" value={loading ? '…' : formatNumber(totals.conversions)} foot="Provider-reported" />
        <Metric label="ROAS" value={loading ? '…' : `${formatNumber(roas)}×`} foot="Conversion value ÷ spend" />
      </section>
      <section className="card">
        <div className="card-head"><h2>Campaign activity</h2><span className="card-note">shared report tool · 7d{summary?.truncated ? ' · truncated' : ''}</span></div>
        {loading ? (
          <div className="card-body">
            {[0, 1, 2, 3].map((i) => <div className="skeleton-line" style={{ width: '100%', height: '0.7rem', marginBottom: i === 3 ? 0 : '1.05rem', opacity: 1 - i * 0.2 }} key={i} />)}
          </div>
        ) : rows.length === 0 ? (
          <Empty title="No campaign rows yet" copy="The connections are healthy, but the accessible accounts returned no campaign activity for this period." />
        ) : (
          <div className="table-wrap"><table>
            <thead><tr><th>Campaign</th><th>Provider</th><th>Status</th><th className="numeric">Spend</th><th className="numeric">Clicks</th><th className="numeric">Conv.</th><th className="numeric">ROAS</th></tr></thead>
            <tbody>
              {rows.slice(0, 12).map((row) => (
                <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
                  <td><strong>{row.entity.name || row.entity.id}</strong><div className="cell-sub">{row.accountId}</div></td>
                  <td><Provider name={row.provider} /></td>
                  <td>{row.entity.status ? <span className={`status ${/paused|disabled|removed/i.test(row.entity.status) ? 'neutral' : ''}`}>{row.entity.status}</span> : '—'}</td>
                  <td className="numeric">{formatNumber(row.metrics.spend)}</td>
                  <td className="numeric">{formatNumber(row.metrics.clicks)}</td>
                  <td className="numeric">{formatNumber(row.metrics.conversions)}</td>
                  <td className="numeric">{formatNumber(row.metrics.roas)}×</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

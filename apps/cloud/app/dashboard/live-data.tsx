'use client';

import { useEffect, useState } from 'react';

interface Summary {
  accounts: Array<{ id: string; name: string; status?: string }>;
  rows: Array<{ provider: string; accountId: string; entity: { id: string; name: string; status?: string }; metrics: Record<string, number> }>;
}

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
  if (!connected) return null;
  return (
    <section className="card full">
      <div className="card-header"><div><h2>All providers — last 7 days</h2><span className="muted">Live account and campaign data; currencies and attribution remain provider-specific.</span></div></div>
      {error ? <p className="error">{error}</p> : null}
      {!summary && !error ? <p className="muted">Loading live data…</p> : null}
      {summary ? <div className="table-wrap"><table><thead><tr><th>Provider</th><th>Campaign</th><th>Status</th><th>Spend</th><th>Clicks</th><th>Conversions</th><th>ROAS</th></tr></thead><tbody>
        {summary.rows.map((row) => <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}><td>{row.provider}</td><td>{row.entity.name}</td><td>{row.entity.status ?? '—'}</td><td>{row.metrics.spend ?? 0}</td><td>{row.metrics.clicks ?? 0}</td><td>{row.metrics.conversions ?? 0}</td><td>{row.metrics.roas ?? 0}</td></tr>)}
      </tbody></table></div> : null}
    </section>
  );
}

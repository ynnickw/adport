import Link from 'next/link';
import { requireTenant } from '@/lib/auth';
import { getCloudStore } from '@/lib/store';
import { normalizedReport } from '@/lib/runtime';
import { Empty, Metric, PageHeader, Provider, formatMoney, formatNumber } from '@/components/ui';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const tenant = await requireTenant();
  const store = getCloudStore();
  const connections = store.listConnections(tenant.workspaceId);
  let rows = [] as Awaited<ReturnType<typeof normalizedReport>>;
  let error: string | undefined;
  try { rows = await normalizedReport(tenant.workspaceId); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  const totals = rows.reduce((sum, row) => ({
    spend: sum.spend + (row.metrics.spend ?? 0), impressions: sum.impressions + (row.metrics.impressions ?? 0),
    clicks: sum.clicks + (row.metrics.clicks ?? 0), conversions: sum.conversions + (row.metrics.conversions ?? 0),
    value: sum.value + (row.metrics.conversion_value ?? 0),
  }), { spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 });
  const roas = totals.spend > 0 ? totals.value / totals.spend : 0;
  return (
    <main className="page">
      <PageHeader eyebrow="Workspace pulse" title="Overview" description="A normalized read across the accounts this workspace is allowed to access." action={<Link className="button secondary" href="/reports">Open full report</Link>} />
      {error ? <div className="error-callout">Provider read failed: {error}</div> : null}
      {connections.length === 0 ? <div className="card"><Empty title="Connect the first account" copy="Start with deterministic demo data or import a locally connected provider into the encrypted workspace vault." href="/connections" action="Open connections" /></div> : (
        <>
          <section className="metrics" aria-label="Performance summary">
            <Metric label="Spend" value={formatMoney(totals.spend)} foot="Last 7 complete days" />
            <Metric label="Clicks" value={formatNumber(totals.clicks)} foot={`${formatNumber(totals.impressions)} impressions`} />
            <Metric label="Conversions" value={formatNumber(totals.conversions)} foot="Provider-reported" />
            <Metric label="ROAS" value={`${formatNumber(roas)}×`} foot="Conversion value ÷ spend" />
          </section>
          <div className="grid-2">
            <section className="card">
              <div className="card-head"><h2>Campaign activity</h2><span className="card-note">shared report tool · 7d</span></div>
              {rows.length === 0 ? <Empty title="No campaign rows yet" copy="The connection is healthy, but the selected accounts returned no campaign activity for this period." /> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Campaign</th><th>Provider</th><th className="numeric">Spend</th><th className="numeric">Clicks</th><th className="numeric">Conv.</th></tr></thead>
                  <tbody>
                    {rows.slice(0, 8).map((row) => (
                      <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
                        <td><strong>{row.entity.name || row.entity.id}</strong></td>
                        <td><Provider name={row.provider} /></td>
                        <td className="numeric">{formatMoney(row.metrics.spend)}</td>
                        <td className="numeric">{formatNumber(row.metrics.clicks)}</td>
                        <td className="numeric">{formatNumber(row.metrics.conversions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </section>
            <aside className="stack">
              <section className="card">
                <div className="card-head"><h2>Connections</h2><Link className="card-note" href="/connections">Manage</Link></div>
                <div className="card-body stack">
                  {connections.map((connection) => (
                    <div key={connection.provider} className="connection-top">
                      <Provider name={connection.provider} />
                      <span className="status neutral">{connection.accountCount} {connection.accountCount === 1 ? 'account' : 'accounts'}</span>
                    </div>
                  ))}
                </div>
              </section>
              <section className="card">
                <div className="card-head"><h2>Governance</h2><span className="status">Enforced</span></div>
                <div className="card-body">
                  <div className="callout">All dashboard reads use the shared registry. Writes stay preview-first, hash-bound, expiring, and audited.</div>
                </div>
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}

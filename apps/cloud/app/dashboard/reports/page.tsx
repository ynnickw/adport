import { Empty, PageHeader, Provider, formatNumber } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { readReport } from '@/lib/cloud/reads';

export const metadata = { title: 'Reports' };

export default async function ReportsPage() {
  const tenant = await requireDashboardTenant();
  const result = await readReport({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: ['tools:read'] }, 'last_30_days');
  const rows = result.ok ? result.data.rows : [];
  return (
    <main className="page">
      <PageHeader title="Campaign report" description="Thirty days, queried through the same cross-platform report tool the REST API and remote MCP endpoint use. Currencies stay provider-specific." />
      {!result.ok ? <div className="error-callout">Provider read failed: {result.error}</div> : null}
      {result.warnings.map((warning) => <div className="error-callout" key={`${warning.provider}:${warning.message}`}>Partial provider read: {warning.message}</div>)}
      <section className="card">
        {rows.length === 0 ? (
          <Empty
            title="No report rows"
            copy={result.connected ? 'The accessible accounts returned no campaign activity for the last thirty days.' : 'Connect a platform to populate the normalized report.'}
            href="/dashboard/connections"
            action="Manage connections"
          />
        ) : (
          <>
            <div className="card-head"><h2>Campaigns</h2><span className="card-note">last 30 days · {rows.length} rows{result.ok && result.data.truncated ? ' · truncated' : ''}</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Campaign</th><th>Provider</th><th>Status</th><th className="numeric">Spend</th><th className="numeric">Impr.</th><th className="numeric">Clicks</th><th className="numeric">Conv.</th><th className="numeric">ROAS</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
                    <td><strong>{row.entity.name || row.entity.id}</strong><div className="cell-sub">{row.accountId}</div></td>
                    <td><Provider name={row.provider} /></td>
                    <td>{row.entity.status ? <span className={`status ${/paused|disabled|removed/i.test(row.entity.status) ? 'neutral' : ''}`}>{row.entity.status}</span> : '—'}</td>
                    <td className="numeric">{formatNumber(row.metrics.spend)}</td>
                    <td className="numeric">{formatNumber(row.metrics.impressions)}</td>
                    <td className="numeric">{formatNumber(row.metrics.clicks)}</td>
                    <td className="numeric">{formatNumber(row.metrics.conversions)}</td>
                    <td className="numeric">{formatNumber(row.metrics.roas)}×</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </section>
    </main>
  );
}

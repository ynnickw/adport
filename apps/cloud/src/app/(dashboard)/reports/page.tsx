import { Empty, PageHeader, Provider, formatMoney, formatNumber } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { normalizedReport } from '@/lib/runtime';

export const metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const tenant = await requireTenant();
  let rows = [] as Awaited<ReturnType<typeof normalizedReport>>;
  let error: string | undefined;
  try { rows = await normalizedReport(tenant.workspaceId, 'last_30_days'); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  return (
    <main className="page">
      <PageHeader eyebrow="Normalized evidence" title="Campaign report" description="Thirty complete days, queried through the same cross-platform report tool used by CLI and MCP." />
      {error ? <div className="error-callout">{error}</div> : null}
      <section className="card">
        {rows.length === 0 ? <Empty title="No report rows" copy="Connect an account with campaign activity or use the demo connection to verify the normalized reporting surface." href="/connections" action="Manage connections" /> : (
          <>
            <div className="card-head"><h2>Campaigns</h2><span className="card-note">last 30 days · {rows.length} rows</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Campaign</th><th>Provider</th><th>Status</th><th className="numeric">Spend</th><th className="numeric">Impr.</th><th className="numeric">Clicks</th><th className="numeric">Conv.</th><th className="numeric">ROAS</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.provider}:${row.accountId}:${row.entity.id}`}>
                    <td><strong>{row.entity.name || row.entity.id}</strong><div className="cell-sub">{row.accountId}</div></td>
                    <td><Provider name={row.provider} /></td>
                    <td>{row.entity.status ? <span className={`status ${row.entity.status.toLowerCase() === 'paused' ? 'neutral' : ''}`}>{row.entity.status}</span> : '—'}</td>
                    <td className="numeric">{formatMoney(row.metrics.spend)}</td>
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

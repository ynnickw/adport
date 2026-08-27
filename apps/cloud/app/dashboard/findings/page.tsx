import { Empty, PageHeader, Provider, formatDate } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { PostgresFindingsStore } from '@/lib/cloud/repository';

export const metadata = { title: 'Findings' };

const TONE: Record<string, string> = { critical: 'critical', warn: 'warn', info: 'neutral' };

export default async function FindingsPage() {
  const tenant = await requireDashboardTenant();
  const findings = await new PostgresFindingsStore(tenant.organizationId).list();
  return (
    <main className="page">
      <PageHeader title="Findings" description="Persisted, evidence-backed audit results for this workspace. Applying a proposed action still requires the normal preview and exact second call." />
      <section className="card">
        {findings.length === 0 ? (
          <Empty title="No findings yet" copy="Ask an Adport-connected agent to run an account audit. Findings remain scoped to this workspace until dismissed or applied." />
        ) : (
          <>
            <div className="card-head"><h2>Audit findings</h2><span className="card-note">{findings.length} total</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Severity</th><th>Finding</th><th>Provider</th><th>Account</th><th>Status</th><th>Updated</th></tr></thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.id}>
                    <td><span className={`status ${TONE[finding.severity] ?? 'neutral'}`}>{finding.severity}</span></td>
                    <td><strong>{finding.title}</strong><div className="cell-sub">{finding.recommendation}</div></td>
                    <td><Provider name={finding.provider} /></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{finding.accountId}</span></td>
                    <td><span className="status neutral">{finding.status}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(finding.updatedAt)}</td>
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

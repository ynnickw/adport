import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { createSyntheticReviewerRuntime } from '@/lib/cloud/synthetic-reviewer';
import type { DashboardTenant } from '@/lib/cloud/dashboard';

/** Reviewer-only server view. Never renders real provider authorization controls. */
export async function SyntheticReviewer({ tenant }: { tenant: DashboardTenant }) {
  const runtime = await createSyntheticReviewerRuntime({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: [] });
  const provider = runtime.ctx.providers.get('demo');
  const [accounts, report] = await Promise.all([
    provider.listAccounts(),
    provider.report({ level: 'campaign', metrics: ['spend', 'clicks', 'conversions'], dateRange: 'last_7_days' }),
  ]);
  return <main className="page">
    <PageHeader title="Synthetic demo" description="Fictional historical data. No real ad accounts, campaigns, or spend. All campaigns stay paused." />
    <p><Link className="button" href="/dashboard/agents">Connect your agent</Link></p>
    <section className="card">
      <div className="card-head"><h2>Accounts</h2><span className="card-note">isolated reviewer workspace</span></div>
      <div className="table-wrap"><table><thead><tr><th>Account</th><th>ID</th><th>Currency</th></tr></thead><tbody>
        {accounts.map(account => <tr key={account.id}><td>{account.name}</td><td>{account.id}</td><td>{account.currency}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className="card" style={{ marginTop: '1rem' }}>
      <div className="card-head"><h2>Last 7 days</h2><span className="card-note">synthetic history</span></div>
      <div className="table-wrap"><table><thead><tr><th>Campaign</th><th>Spend</th><th>Clicks</th><th>Conversions</th></tr></thead><tbody>
        {report.rows.map(row => <tr key={`${row.accountId}:${row.entity.id}`}><td>{row.entity.name}</td><td>{row.metrics.spend} {row.currency}</td><td>{row.metrics.clicks}</td><td>{row.metrics.conversions}</td></tr>)}
      </tbody></table></div>
    </section>
    <p className="muted">Use <code>demo_list_campaigns</code> to read budgets and <code>demo_set_budget</code> to preview a change. Apply requires the matching pending token. Real provider connections are disabled in this workspace.</p>
  </main>;
}

import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { readAccounts } from '@/lib/cloud/reads';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  const tenant = await requireDashboardTenant();
  const result = await readAccounts({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: ['tools:read'] });
  const accounts = result.ok ? result.data : [];
  return (
    <main className="page">
      <PageHeader eyebrow="Scoped inventory" title="Accounts" description="The ad accounts each connected grant can reach. Only these accounts can be queried or changed by this organization's runtime." />
      {!result.ok ? <div className="error-callout">Provider read failed: {result.error}</div> : null}
      <section className="card">
        {accounts.length === 0 ? (
          <Empty
            title={result.connected ? 'No accessible accounts' : 'No accounts yet'}
            copy={result.connected ? 'The connected grants did not return any ad accounts. Check the account access of the authorizing user, then re-authorize.' : 'Connect a platform to discover the ad accounts its grant can access.'}
            href="/dashboard/connections"
            action="Open connections"
          />
        ) : (
          <>
            <div className="card-head"><h2>Accessible accounts</h2><span className="card-note">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Account</th><th>Provider</th><th>ID</th><th>Currency</th><th>Status</th></tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={`${account.provider}:${account.id}`}>
                    <td><strong>{account.name || account.id}</strong></td>
                    <td><Provider name={account.provider} /></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{account.id}</span></td>
                    <td>{account.currency ?? '—'}</td>
                    <td><span className={`status ${account.status && /paused|disabled|removed|inactive/i.test(account.status) ? 'neutral' : ''}`}>{account.status ?? 'Available'}</span></td>
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

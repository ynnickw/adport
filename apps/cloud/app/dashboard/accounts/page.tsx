import Link from 'next/link';
import { Empty, PageHeader, Provider } from '@/components/ui';
import { accountStatusPresentation } from '@/lib/cloud/account-status';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listConnections } from '@/lib/cloud/repository';
import { readAccounts } from '@/lib/cloud/reads';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  const tenant = await requireDashboardTenant();
  const [result, connections] = await Promise.all([
    readAccounts({ organizationId: tenant.organizationId, userId: tenant.userId, role: tenant.role, scopes: ['tools:read'] }),
    listConnections(tenant.organizationId),
  ]);
  const accounts = result.ok ? result.data : [];
  const accountProviders = new Set(accounts.map((account) => account.provider));
  const emptyConnections = connections.filter((connection) => connection.status === 'connected' && !accountProviders.has(connection.provider));
  return (
    <main className="page">
      <PageHeader title="Accounts" description="The ad accounts each connected grant can reach. Only these accounts can be queried or changed by this organization's runtime." />
      {!result.ok ? <div className="error-callout">Provider read failed: {result.error}</div> : null}
      {result.warnings.map((warning) => <div className="error-callout" key={`${warning.provider}:${warning.message}`}>Partial provider read: {warning.message}</div>)}
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
                {accounts.map((account) => {
                  const status = accountStatusPresentation(account.status);
                  return (
                    <tr key={`${account.provider}:${account.id}`}>
                      <td><strong>{account.name || account.id}</strong></td>
                      <td><Provider name={account.provider} /></td>
                      <td><span className="cell-sub" style={{ marginTop: 0 }}>{account.id}</span></td>
                      <td>{account.currency ?? '—'}</td>
                      <td><span className={`status ${status.tone}`}>{status.label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </>
        )}
      </section>
      {emptyConnections.length > 0 ? (
        <section className="card" style={{ marginTop: '0.9rem' }}>
          <div className="card-head"><h2>Connected without account access</h2><span className="card-note">authorization needs attention</span></div>
          <div className="row-list">
            {emptyConnections.map((connection) => (
              <div className="row-item" key={connection.provider}>
                <div>
                  <Provider name={connection.provider} />
                  <div className="cell-sub">{connection.externalLabel ?? 'OAuth connected'} · no advertiser account was returned. Re-authorize and explicitly select an ad account.</div>
                </div>
                <Link className="button secondary small" href="/dashboard/connections">Review connection</Link>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

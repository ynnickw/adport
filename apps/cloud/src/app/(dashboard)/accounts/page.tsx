import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { listCloudAccounts } from '@/lib/runtime';

export const metadata = { title: 'Accounts' };

export default async function AccountsPage() {
  const tenant = await requireTenant();
  const accounts = await listCloudAccounts(tenant.workspaceId);
  return (
    <main className="page">
      <PageHeader eyebrow="Scoped inventory" title="Accounts" description="Only these discovered and allowlisted accounts can be queried by the workspace runtime." />
      <section className="card">
        {accounts.length === 0 ? <Empty title="No accounts allowlisted" copy="Connect a provider to discover its accessible ad accounts." href="/connections" action="Open connections" /> : (
          <>
            <div className="card-head"><h2>Allowlisted accounts</h2><span className="card-note">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Account</th><th>Provider</th><th>ID</th><th>Currency</th><th>Status</th></tr></thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={`${account.provider}:${account.id}`}>
                    <td><strong>{account.name}</strong></td>
                    <td><Provider name={account.provider} /></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{account.id}</span></td>
                    <td>{account.currency ?? '—'}</td>
                    <td><span className="status">{account.status ?? 'Available'}</span></td>
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

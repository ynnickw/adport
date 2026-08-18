import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { getCloudStore } from '@/lib/store';

export const metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const tenant = await requireTenant();
  const pending = await getCloudStore().pending(tenant.workspaceId).list();
  return (
    <main className="page">
      <PageHeader eyebrow="Human control" title="Approvals" description="Validated operations remain hash-bound and expiring. This milestone exposes the durable queue read-only." />
      <section className="card">
        {pending.length === 0 ? <Empty title="No operations awaiting approval" copy="When a guarded write is previewed, its exact operation and expiry will appear here." /> : (
          <>
            <div className="card-head"><h2>Pending operations</h2><span className="card-note">{pending.length} awaiting review</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Operation</th><th>Provider</th><th>Account</th><th>Expires</th></tr></thead>
              <tbody>
                {pending.map((operation) => (
                  <tr key={operation.id}>
                    <td><strong>{operation.preview.summary}</strong><div className="cell-sub">{operation.id}</div></td>
                    <td><Provider name={operation.provider} /></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{operation.op.accountId}</span></td>
                    <td>{new Date(operation.expiresAt).toLocaleString()}</td>
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

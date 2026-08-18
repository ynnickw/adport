import { Empty, PageHeader, Provider, formatDate } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listPendingOperations } from '@/lib/cloud/repository';

export const metadata = { title: 'Approvals' };

export default async function ApprovalsPage() {
  const tenant = await requireDashboardTenant();
  const pending = await listPendingOperations(tenant.organizationId);
  return (
    <main className="page">
      <PageHeader eyebrow="Human control" title="Approvals" description="Previewed writes waiting for their exact second call. Each entry is hash-bound to its arguments and expires under the organization policy." />
      <section className="card">
        {pending.length === 0 ? (
          <Empty title="No operations awaiting approval" copy="When an agent previews a guarded write, its exact operation, preview, and expiry appear here until it is applied or expires." />
        ) : (
          <>
            <div className="card-head"><h2>Pending operations</h2><span className="card-note">{pending.length} awaiting review</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Operation</th><th>Provider</th><th>Account</th><th>Kind</th><th>Expires</th></tr></thead>
              <tbody>
                {pending.map((operation) => (
                  <tr key={operation.id}>
                    <td><strong>{operation.preview?.summary ?? operation.operation.tool}</strong><div className="cell-sub">{operation.id}</div></td>
                    <td><Provider name={operation.provider} /></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{operation.operation.accountId}</span></td>
                    <td><span className="status neutral">{operation.operation.kind}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(operation.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </section>
      <section className="card" style={{ marginTop: '0.9rem' }}>
        <div className="card-head"><h2>Execution contract</h2><span className="status">Enforced</span></div>
        <div className="card-body">
          <div className="callout">Preview first → identical argument hash → explicit approval → single apply → append-only audit. Provider coercions are always visible in the preview.</div>
        </div>
      </section>
    </main>
  );
}

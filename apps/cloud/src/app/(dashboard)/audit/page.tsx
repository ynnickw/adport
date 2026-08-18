import { Empty, PageHeader, Provider } from '@/components/ui';
import { requireTenant } from '@/lib/auth';
import { getCloudStore } from '@/lib/store';

export const metadata = { title: 'Audit' };
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const tenant = await requireTenant();
  const entries = (await getCloudStore().audit(tenant.workspaceId).read(100)).reverse();
  return (
    <main className="page">
      <PageHeader eyebrow="Append-only evidence" title="Audit log" description="Validation, application, rejection, and reconciliation events for this workspace." />
      <section className="card">
        {entries.length === 0 ? <Empty title="No audit events yet" copy="Read operations do not create audit noise. Guarded write validations and applications will appear here." /> : (
          <>
            <div className="card-head"><h2>Recent events</h2><span className="card-note">latest {entries.length} entries</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Time</th><th>Event</th><th>Provider</th><th>Summary</th></tr></thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={`${entry.ts}:${index}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(entry.ts).toLocaleString()}</td>
                    <td><span className={`status ${entry.event === 'rejected' ? 'critical' : ''}`}>{entry.event}</span></td>
                    <td><Provider name={entry.provider} /></td>
                    <td>{entry.summary}<div className="cell-sub">{entry.tool} · {entry.accountId}</div></td>
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

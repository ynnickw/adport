import { Empty, PageHeader, Provider, formatDate } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listAuditEvents } from '@/lib/cloud/repository';

export const metadata = { title: 'Audit log' };

const TONE: Record<string, string> = { rejected: 'critical', revoked: 'warn', deletion_requested: 'critical', note: 'neutral', member_removed: 'warn', api_key_revoked: 'warn' };

export default async function AuditPage() {
  const tenant = await requireDashboardTenant();
  const entries = await listAuditEvents(tenant.organizationId, 150);
  return (
    <main className="page">
      <PageHeader eyebrow="Append-only evidence" title="Audit log" description="Connection, approval, application, rejection, and administration events for this organization. Reads do not create audit noise." />
      <section className="card">
        {entries.length === 0 ? (
          <Empty title="No audit events yet" copy="Connecting a platform, previewing a guarded write, or changing team settings will appear here." />
        ) : (
          <>
            <div className="card-head"><h2>Recent events</h2><span className="card-note">latest {entries.length} entries</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>Time</th><th>Event</th><th>Provider</th><th>Summary</th><th>Actor</th></tr></thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(entry.createdAt)}</td>
                    <td><span className={`status ${TONE[entry.event] ?? ''}`}>{entry.event.replaceAll('_', ' ')}</span></td>
                    <td>{entry.provider === 'cloud' ? <span className="cell-sub" style={{ marginTop: 0 }}>cloud</span> : <Provider name={entry.provider} />}</td>
                    <td>{entry.summary}<div className="cell-sub">{entry.tool} · {entry.accountId}</div></td>
                    <td><span className="cell-sub" style={{ marginTop: 0 }}>{entry.apiKeyId ? 'API key' : entry.actorUserId ? 'Member' : 'System'}</span></td>
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

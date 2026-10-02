import Link from 'next/link';
import { Empty, PageHeader, Provider, formatDate, formatRelative } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { listAuditEvents } from '@/lib/cloud/repository';

export const metadata = { title: 'Audit log' };

// Same colours as the adport.dev audit strip: previews orange, applied green, rejections red.
const TONE: Record<string, string> = { validated: 'pending', rejected: 'critical', revoked: 'warn', deletion_requested: 'critical', note: 'neutral', member_removed: 'warn', api_key_revoked: 'warn' };

const FILTERS = [
  { id: 'all', label: 'All events', match: () => true },
  { id: 'previews', label: 'Previews', match: (event: string) => event === 'validated' },
  { id: 'applied', label: 'Applied', match: (event: string) => event === 'applied' },
  { id: 'rejected', label: 'Rejected', match: (event: string) => event === 'rejected' },
  { id: 'admin', label: 'Connections & admin', match: (event: string) => !['validated', 'applied', 'rejected'].includes(event) },
] as const;

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const tenant = await requireDashboardTenant();
  const [entries, params] = await Promise.all([listAuditEvents(tenant.organizationId, 150), searchParams]);
  const filter = FILTERS.find((item) => item.id === params.show) ?? FILTERS[0];
  const visible = entries.filter((entry) => filter.match(entry.event));
  const now = Date.now();
  return (
    <main className="page">
      <PageHeader title="Audit log" description="Connection, approval, application, rejection, and administration events for this organization. Reads do not create audit noise." />
      {entries.length ? (
        <nav className="filter-chips" aria-label="Filter audit events">
          {FILTERS.map((item) => {
            const count = entries.filter((entry) => item.match(entry.event)).length;
            return (
              <Link key={item.id} href={item.id === 'all' ? '/dashboard/audit' : `/dashboard/audit?show=${item.id}`} prefetch={false} aria-current={item === filter ? 'page' : undefined}>
                {item.label}<span className="chip-count">{count}</span>
              </Link>
            );
          })}
        </nav>
      ) : null}
      <section className="card">
        {entries.length === 0 ? (
          <Empty title="No audit events yet" copy="Connecting a platform, previewing a guarded write, or changing team settings will appear here." />
        ) : visible.length === 0 ? (
          <Empty title={`No ${filter.label.toLowerCase()} yet`} copy="Nothing in the latest 150 events matches this filter." href="/dashboard/audit" action="Show all events" />
        ) : (
          <>
            <div className="card-head"><h2>{filter.id === 'all' ? 'Recent events' : filter.label}</h2><span className="card-note">{visible.length} of the latest {entries.length}</span></div>
            <div className="table-wrap"><table className="stack-on-mobile">
              <thead><tr><th>Time</th><th>Event</th><th>Provider</th><th>Summary</th><th>Actor</th></tr></thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="Time" className="nowrap"><time dateTime={new Date(entry.createdAt).toISOString()} title={formatDate(entry.createdAt)}>{formatRelative(entry.createdAt, now)}</time></td>
                    <td data-label="Event"><span className={`status ${TONE[entry.event] ?? ''}`}>{entry.event.replaceAll('_', ' ')}</span></td>
                    <td data-label="Provider">{entry.provider === 'cloud' ? <span className="cell-sub flush">cloud</span> : <Provider name={entry.provider} />}</td>
                    <td data-label="Summary">{entry.summary}<div className="cell-sub">{entry.tool} · {entry.accountId}</div></td>
                    <td data-label="Actor"><span className="cell-sub flush">{entry.apiKeyId ? 'API key' : entry.actorUserId ? 'Member' : 'System'}</span></td>
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

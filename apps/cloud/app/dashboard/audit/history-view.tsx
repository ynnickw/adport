import Link from 'next/link';
import { Empty, PageHeader, Provider, formatDate, formatRelative } from '@/components/ui';
import { AUDIT_FILTERS, type listAuditEventPage, type AuditFilter } from '@/lib/cloud/audit-history';
import { Disclosure } from '@/components/controls';
import { FilterLinks } from '@/components/list-controls';
import { DataCell, DataTable } from '@/components/data-table';

// Same colours as the adport.dev audit strip: previews orange, applied green, rejections red.
const TONE: Record<string, string> = { validated: 'pending', rejected: 'critical', revoked: 'warn', deletion_requested: 'critical', note: 'neutral', member_removed: 'warn', api_key_revoked: 'warn' };
const EVENT_LABEL: Record<string, string> = { validated: 'Previewed', applied: 'Applied', rejected: 'Rejected', connected: 'Connected', revoked: 'Revoked', note: 'Note' };
function historyHref(filter: AuditFilter, direction?: 'older' | 'newer', cursor?: string) {
  const query = new URLSearchParams();
  if (filter !== 'all') query.set('show', filter);
  if (direction && cursor) query.set(direction, cursor);
  const suffix = query.toString();
  return suffix ? '/dashboard/audit?' + suffix : '/dashboard/audit';
}

export function AuditHistory({ filter, result, paged }: {
  filter: (typeof AUDIT_FILTERS)[number];
  result: Awaited<ReturnType<typeof listAuditEventPage>>;
  paged: boolean;
}) {
  const { rows, newerCursor, olderCursor } = result;
  const now = Date.now();
  return (
    <main className="page">
      <PageHeader title="History" />
      <FilterLinks className="history-filters" label="Filter audit events" value={filter.id}
        options={AUDIT_FILTERS.map(item => ({ value: item.id, label: item.label, href: historyHref(item.id) }))} />
      <section className="card" aria-label="Audit events">
        {rows.length === 0 && paged ? (
          <Empty title="No events on this page" copy="Older events may have reached the end of your retention period." href={historyHref(filter.id)} action="Back to latest" />
        ) : rows.length === 0 && filter.id === 'all' ? (
          <Empty title="No activity yet" copy="Connections and changes will appear here." />
        ) : rows.length === 0 ? (
          <Empty title="No matching activity" copy="No retained events match this filter." href={historyHref('all')} action="Show all events" />
        ) : (
          <>
            <div className="card-head"><h2>{filter.id === 'all' ? 'Activity' : filter.label}</h2><span className="card-note">{rows.length} {rows.length === 1 ? 'event' : 'events'} · {newerCursor ? 'Older activity' : 'Latest activity'}</span></div>
            <DataTable responsive columns={['Time', 'Event', 'Provider', 'Summary', 'Actor']}>
                {rows.map((entry) => (
                  <tr key={entry.id}>
                    <DataCell label="Time" className="nowrap"><time dateTime={new Date(entry.createdAt).toISOString()} title={formatDate(entry.createdAt)}>{formatRelative(entry.createdAt, now)}</time></DataCell>
                    <DataCell label="Event"><span className={`status ${TONE[entry.event] ?? ''}`}>{EVENT_LABEL[entry.event] ?? entry.event.replaceAll('_', ' ')}</span></DataCell>
                    <DataCell label="Provider">{entry.provider === 'cloud' ? <span className="cell-sub flush">cloud</span> : <Provider name={entry.provider} />}</DataCell>
                    <DataCell label="Summary">{entry.summary}<Disclosure className="history-details" label="Details"><div className="cell-sub">{entry.tool} · {entry.accountId}<br />{formatDate(entry.createdAt)}</div></Disclosure></DataCell>
                    <DataCell label="Actor"><span className="cell-sub flush">{entry.apiKeyId ? 'API key' : entry.actorUserId ? 'Member' : 'System'}</span></DataCell>
                  </tr>
                ))}
            </DataTable>
            {newerCursor || olderCursor ? <nav className="history-pagination" aria-label="Audit log pagination">
              {newerCursor ? <Link className="button secondary small" href={historyHref(filter.id)} prefetch={false}>Back to latest</Link> : null}
              <div className="row-actions">
                {newerCursor ? <Link className="button secondary small" href={historyHref(filter.id, 'newer', newerCursor)} prefetch={false}>← Newer events</Link> : null}
                {olderCursor ? <Link className="button secondary small" href={historyHref(filter.id, 'older', olderCursor)} prefetch={false}>Older events →</Link> : null}
              </div>
            </nav> : null}
          </>
        )}
      </section>
    </main>
  );
}

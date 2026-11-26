import 'server-only';
import { db } from '@/lib/db';

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_FILTERS = [
  { id: 'all', label: 'All events' },
  { id: 'previews', label: 'Previews' },
  { id: 'applied', label: 'Applied' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'admin', label: 'Connections & admin' },
] as const;

export type AuditFilter = typeof AUDIT_FILTERS[number]['id'];
type Position = { timestamp: string; id: string };
type Boundary = { direction: 'older' | 'newer'; position: Position };

interface AuditEventRow {
  id: string;
  event: string;
  provider: string;
  tool: string;
  accountId: string;
  summary: string;
  actorUserId: string | null;
  apiKeyId: string | null;
  createdAt: Date;
  cursorTimestamp: string;
}

export function encodeAuditCursor(projectId: string, filter: AuditFilter, position: Position) {
  return Buffer.from(JSON.stringify([projectId, filter, position.timestamp, position.id])).toString('base64url');
}

export function decodeAuditCursor(value: unknown, projectId: string, filter: AuditFilter): Position | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== projectId || decoded[1] !== filter) return undefined;
    const [, , timestamp, id] = decoded;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) return undefined;
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) return undefined;
    return { timestamp, id };
  } catch { return undefined; }
}

export async function listAuditEventPage(projectId: string, filter: AuditFilter, boundary?: Boundary) {
  const sql = db();
  const scope = filter === 'all' ? sql`` : filter === 'admin'
    ? sql`and event not in ('validated', 'applied', 'rejected')`
    : sql`and event = ${filter === 'previews' ? 'validated' : filter}`;
  const newer = boundary?.direction === 'newer';
  const edge = !boundary ? sql`` : newer
    ? sql`and (created_at, id) > (${boundary.position.timestamp}::text::timestamptz, ${boundary.position.id}::text::bigint)`
    : sql`and (created_at, id) < (${boundary.position.timestamp}::text::timestamptz, ${boundary.position.id}::text::bigint)`;
  // PostgreSQL timestamps carry microseconds and IDs are bigint; JavaScript Date/number must not make the cursor.
  const batch = await sql<AuditEventRow[]>`
    select id::text as id, event, provider, tool, account_id, summary, actor_user_id, api_key_id, created_at,
      to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_timestamp
    from public.audit_events
    where organization_id = ${projectId} ${scope} ${edge}
    order by ${newer ? sql`created_at asc, id asc` : sql`created_at desc, id desc`}
    limit ${AUDIT_PAGE_SIZE + 1}
  `;
  const more = batch.length > AUDIT_PAGE_SIZE;
  const rows = batch.slice(0, AUDIT_PAGE_SIZE);
  if (newer) rows.reverse();
  if (!rows.length) return { rows, newerCursor: undefined, olderCursor: undefined };
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  let opposite = false;
  if (boundary) {
    const check = newer
      ? sql`(created_at, id) < (${last.cursorTimestamp}::text::timestamptz, ${last.id}::text::bigint)`
      : sql`(created_at, id) > (${first.cursorTimestamp}::text::timestamptz, ${first.id}::text::bigint)`;
    const [result] = await sql<Array<{ found: boolean }>>`
      select exists (
        select 1 from public.audit_events where organization_id = ${projectId} ${scope} and ${check}
      ) as found
    `;
    opposite = result?.found ?? false;
  }
  const token = (row: AuditEventRow) => encodeAuditCursor(projectId, filter, { timestamp: row.cursorTimestamp, id: row.id });
  return { rows, newerCursor: (newer ? more : opposite) ? token(first) : undefined, olderCursor: (newer ? opposite : more) ? token(last) : undefined };
}

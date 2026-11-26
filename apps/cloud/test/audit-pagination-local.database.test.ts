import { afterAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { decodeAuditCursor, listAuditEventPage } from '@/lib/cloud/audit-history';

const socket = process.env.ADPORT_AUDIT_TEST_SOCKET;
vi.mock('@/lib/db', () => ({ db: () => sql }));
const sql = socket && /^\/tmp\/adport-audit-qa\.[A-Za-z0-9]+$/.test(socket)
  ? postgres({ host: socket, port: 55428, user: 'adport_audit_qa', database: 'postgres', prepare: false, transform: { column: postgres.camel.column } })
  : undefined;
afterAll(async () => { await sql?.end(); });

it.skipIf(!sql)('walks the retained log without gaps, including microsecond ties and large identifiers', async () => {
  const project = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  await sql!`create table public.audit_events (
    id bigint primary key, organization_id uuid not null, event text not null,
    provider text not null default 'cloud', tool text not null default 'fixture',
    account_id text not null default 'test', summary text not null default 'Fixture',
    actor_user_id uuid, api_key_id uuid, created_at timestamptz not null
  )`;
  await sql!`create index audit_events_org_created_idx on public.audit_events (organization_id, created_at desc, id desc)`;
  await sql!`insert into public.audit_events (id, organization_id, event, created_at)
    select 9007199254740993::bigint + i, ${project}::uuid,
      case when i > 150 then 'applied' when i % 2 = 0 then 'connected' else 'validated' end,
      '2026-11-25T10:20:30.123456Z'::timestamptz - ((i / 2) * interval '1 microsecond')
    from generate_series(0, 219) i`;
  await sql!`insert into public.audit_events (id, organization_id, event, created_at) values (1, ${other}::uuid, 'applied', now())`;
  const expected = await sql!<{ id: string }[]>`select id::text from public.audit_events where organization_id = ${project} order by created_at desc, id desc`;
  const pages: string[][] = [];
  let page = await listAuditEventPage(project, 'all');
  expect(page.newerCursor).toBeUndefined();
  // Insert a newer row after the first page, like a concurrent client would.
  await sql!`insert into public.audit_events (id, organization_id, event, created_at) values (2, ${project}::uuid, 'connected', '2026-11-25T10:20:31Z')`;
  while (true) {
    pages.push(page.rows.map(row => row.id));
    if (!page.olderCursor) break;
    page = await listAuditEventPage(project, 'all', { direction: 'older', position: decodeAuditCursor(page.olderCursor, project, 'all')! });
  }
  expect(pages.map(rows => rows.length)).toEqual([50, 50, 50, 50, 20]);
  expect(pages.flat()).toEqual(expected.map(row => row.id));
  expect((await listAuditEventPage(project, 'all', { direction: 'newer', position: decodeAuditCursor(page.newerCursor, project, 'all')! })).rows.map(row => row.id)).toEqual(pages[3]);
  const applied = await listAuditEventPage(project, 'applied');
  expect(applied.rows).toHaveLength(50);
  expect(applied.rows.every(row => row.event === 'applied' && row.id !== '1')).toBe(true);
  const rest = await listAuditEventPage(project, 'applied', { direction: 'older', position: decodeAuditCursor(applied.olderCursor, project, 'applied')! });
  expect(rest.rows).toHaveLength(19);
  expect(rest.olderCursor).toBeUndefined();
  expect((await listAuditEventPage(project, 'admin')).rows.every(row => row.event === 'connected')).toBe(true);
});

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import AuditPage from '@/app/dashboard/audit/page';
import { decodeAuditCursor, encodeAuditCursor, listAuditEventPage } from '@/lib/cloud/audit-history';

const project = 'project-a';
const position = { timestamp: '2026-11-25T10:20:30.123456Z', id: '9007199254740993' };
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: async () => ({ organizationId: 'project-a' }) }));
vi.mock('@/lib/cloud/audit-history', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/cloud/audit-history')>(), listAuditEventPage: vi.fn() }));

const query = vi.mocked(listAuditEventPage);
const draw = async (params: Record<string, string | string[] | undefined>) => renderToStaticMarkup(await AuditPage({ searchParams: Promise.resolve(params) }));
beforeEach(() => query.mockReset());

it('uses lossless and project-and-filter-bound cursor positions', () => {
  const token = encodeAuditCursor(project, 'applied', position);
  expect(decodeAuditCursor(token, project, 'applied')).toEqual(position);
  expect(decodeAuditCursor(token, 'project-b', 'applied')).toBeUndefined();
  expect(decodeAuditCursor(token, project, 'all')).toBeUndefined();
  const invalid = [
    { ...position, id: '9223372036854775808' },
    { ...position, timestamp: '2026-02-30T00:00:00.000000Z' },
    { ...position, timestamp: 'not-a-date' },
  ];
  for (const locator of invalid) expect(decodeAuditCursor(encodeAuditCursor(project, 'applied', locator), project, 'applied')).toBeUndefined();
});

it('keeps the active filter on both page links but resets it when switching filters', async () => {
  const token = encodeAuditCursor(project, 'applied', position);
  query.mockResolvedValue({ rows: [{ ...position, createdAt: new Date(position.timestamp), cursorTimestamp: position.timestamp, provider: 'cloud', event: 'applied', tool: 'tool', accountId: 'test', summary: 'Change applied', actorUserId: null, apiKeyId: null }], newerCursor: 'newer-token', olderCursor: 'older-token' });
  const html = await draw({ show: 'applied', older: token });
  expect(query).toHaveBeenCalledWith(project, 'applied', { direction: 'older', position });
  expect(html).toContain('show=applied&amp;older=older-token');
  expect(html).toContain('show=applied&amp;newer=newer-token');
  expect(html).toContain('href="/dashboard/audit?show=rejected"');
});

it('recovers gracefully when older events are no longer retained', async () => {
  const token = encodeAuditCursor(project, 'rejected', position);
  query.mockResolvedValue({ rows: [], newerCursor: undefined, olderCursor: undefined });
  const html = await draw({ show: 'rejected', older: token });
  expect(html).toContain('No events on this page');
  expect(html).toContain('href="/dashboard/audit?show=rejected">Back to latest');
});

it.each(['invalid', 'ambiguous', 'other project', 'repeated'])('starts at latest for an %s cursor', async kind => {
  query.mockResolvedValue({ rows: [], newerCursor: undefined, olderCursor: undefined });
  const token = encodeAuditCursor(kind === 'other project' ? 'project-b' : project, 'all', position);
  await draw(kind === 'ambiguous' ? { older: token, newer: token } : { older: kind === 'repeated' ? [token, token] : kind === 'invalid' ? 'invalid' : token });
  expect(query).toHaveBeenCalledWith(project, 'all', undefined);
});

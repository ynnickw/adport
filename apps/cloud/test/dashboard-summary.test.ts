import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), report: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/reads', () => ({ readReport: mocks.report }));
import { GET } from '@/app/api/dashboard/summary/route';
beforeEach(() => vi.clearAllMocks());

it('preserves registry currency groups, unavailable metrics and partial-result status for the dashboard', async () => {
  const principal = { organizationId: 'client-project', scopes: ['tools:read'] };
  const summary = { complete: false, groups: [
    { key: 'EUR', currency: 'EUR', accounts: [{ provider: 'google', account_id: 'euro-account' }], metrics: { spend: 100, conversions: 4, roas: 2 } },
    { key: 'USD', currency: 'USD', accounts: [{ provider: 'meta', account_id: 'dollar-account' }], metrics: { spend: 300, conversions: null, roas: null } },
    { key: '["google","unknown"]', currency: null, accounts: [{ provider: 'google', account_id: 'unknown' }], metrics: { spend: 50, conversions: 0, roas: null } },
  ] };
  mocks.principal.mockResolvedValue(principal);
  mocks.report.mockResolvedValue({ ok: true, data: { rows: [], truncated: true, summary }, warnings: [{ provider: 'google', message: 'Partial report' }] });
  const response = await GET(new Request('https://app.adport.test/api/dashboard/summary?organization_id=client-project'));
  expect(mocks.principal).toHaveBeenCalledWith('client-project');
  expect(mocks.report).toHaveBeenCalledWith(principal, 'last_7_days');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ summary, truncated: true, warnings: [{ provider: 'google', message: 'Partial report' }] });
});

it.each(['today', 'yesterday', 'last_30_days', 'this_month'])('passes the selected %s period to the shared report', async range => {
  const principal = { organizationId: 'client-project', scopes: ['tools:read'] };
  mocks.principal.mockResolvedValue(principal);
  mocks.report.mockResolvedValue({ ok: true, data: { rows: [], truncated: false }, warnings: [] });
  const response = await GET(new Request(`https://app.adport.test/api/dashboard/summary?range=${range}`));
  expect(response.status).toBe(200);
  expect(mocks.report).toHaveBeenCalledWith(principal, range);
});

it('passes an inclusive custom range unchanged to the report', async () => {
  mocks.principal.mockResolvedValue({ organizationId: 'client-project' });
  mocks.report.mockResolvedValue({ ok: true, data: { rows: [], truncated: false }, warnings: [] });
  const response = await GET(new Request('https://app.adport.test/api/dashboard/summary?range=custom&from=2026-01-01&to=2026-01-31'));
  expect(response.status).toBe(200);
  expect(mocks.report).toHaveBeenCalledWith(expect.anything(), { start: '2026-01-01', end: '2026-01-31' });
});

it.each(['range=bad', 'range=custom', 'range=custom&from=2026-02-30&to=2026-03-01', 'range=custom&from=2026-02-02&to=2026-02-01', 'range=custom&from=2099-01-01&to=2099-01-02'])('rejects invalid dates before reading providers: %s', async query => {
  mocks.principal.mockResolvedValue({ organizationId: 'client-project' });
  const response = await GET(new Request(`https://app.adport.test/api/dashboard/summary?${query}`));
  expect(response.status).toBe(400); expect(mocks.report).not.toHaveBeenCalled();
});

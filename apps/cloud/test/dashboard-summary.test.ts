import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ principal: vi.fn(), report: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.principal }));
vi.mock('@/lib/cloud/reads', () => ({ readReport: mocks.report }));
import { GET } from '@/app/api/dashboard/summary/route';

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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GRAVITY_API_BASE } from '@adport/provider-gravity';

const mocks = vi.hoisted(() => ({ session: vi.fn(), stage: vi.fn(), upsert: vi.fn(), verify: vi.fn(), audit: vi.fn(), request: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/repository', () => ({ upsertProviderConnection: mocks.upsert, setConnectionVerification: mocks.verify, recordAudit: mocks.audit }));
vi.mock('@/lib/cloud/account-selection', () => ({ stageAccountSelection: mocks.stage }));
import { POST } from '@/app/api/connections/[provider]/route';

const project = '11111111-1111-4111-8111-111111111111', apiKey = 'fixture-advertiser-key';
const post = (origin = 'https://app.adport.test') => POST(new Request('https://app.adport.test/api/connections/gravity', {
  method: 'POST', headers: { origin }, body: JSON.stringify({ organization_id: project, api_key: apiKey }),
}), { params: Promise.resolve({ provider: 'gravity' }) });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', mocks.request);
  mocks.session.mockResolvedValue({ organizationId: project, userId: 'owner', role: 'owner' });
  mocks.request.mockImplementation(async () => Response.json({ advertiser_id: 'adv-1', name: 'Example', email: 'private@example.test' }));
  mocks.upsert.mockResolvedValue('connection');
});
afterEach(() => vi.unstubAllGlobals());

it('verifies the advertiser before storing the key and offers the verified account for selection', async () => {
  const result = await post();
  expect(result.status).toBe(200);
  expect(String(mocks.request.mock.calls[0]![0])).toBe(GRAVITY_API_BASE + 'info');
  expect(mocks.request.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { 'x-api-key': apiKey } });
  expect(mocks.request.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]!);
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gravity', credential: { apiKey }, organizationId: project }));
  expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gravity', returnPath: '/dashboard/connections',
    accounts: [{ provider: 'gravity', id: 'adv-1', name: 'Example', currency: 'USD', timezone: 'UTC' }] }));
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(apiKey);
});

it('keeps the previous connection on invalid keys and checks origin and role before provider access', async () => {
  expect((await post('https://other.example')).status).toBe(403);
  mocks.session.mockResolvedValueOnce({ organizationId: project, role: 'viewer' });
  expect((await post()).status).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.request.mockResolvedValueOnce(Response.json({ detail: apiKey }, { status: 401 }));
  const failed = await post();
  expect(failed.status).toBe(502); expect(await failed.text()).not.toContain(apiKey);
  expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
});

import { beforeEach, expect, it, vi } from 'vitest';
import { createHostedMatomoProvider } from '@/lib/cloud/matomo';

const mocks = vi.hoisted(() => ({ session: vi.fn(), upsert: vi.fn(), stage: vi.fn(), verify: vi.fn(), audit: vi.fn(), request: vi.fn() }));
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: mocks.request }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/repository', () => ({ upsertProviderConnection: mocks.upsert, setConnectionVerification: mocks.verify, recordAudit: mocks.audit }));
vi.mock('@/lib/cloud/account-selection', () => ({ stageAccountSelection: mocks.stage }));
import { POST } from '@/app/api/connections/[provider]/route';

const project = '11111111-1111-4111-8111-111111111111';
const input = { organization_id: project, url: 'https://analytics.example.org/matomo/index.php', token_auth: 'test-matomo-token' };
const post = (body: unknown, origin = 'https://app.adport.test', requestOrigin = 'https://app.adport.test') => POST(new Request(requestOrigin + '/api/connections/matomo', {
  method: 'POST', headers: { origin }, body: JSON.stringify(body),
}), { params: Promise.resolve({ provider: 'matomo' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ organizationId: project, userId: 'user', role: 'owner' });
  mocks.request.mockImplementation(async () => Response.json([{ idsite: '21', name: 'Example', currency: 'EUR' }]));
  mocks.upsert.mockResolvedValue('connection');
});

it('verifies the token and stages sites for project selection before assistants can use them', async () => {
  const response = await post(input);
  expect(response.status).toBe(200);
  const url = 'https://analytics.example.org/matomo';
  expect(mocks.request).toHaveBeenCalledWith(url + '/index.php', expect.objectContaining({ method: 'POST', redirect: 'error', dispatcher: expect.anything() }));
  expect(mocks.request.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]!);
  expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'matomo', credential: { url, tokenAuth: input.token_auth } }));
  expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'matomo', accounts: [{ provider: 'matomo', id: '21', name: 'Example', currency: 'EUR' }], returnPath: '/dashboard/analytics' }));
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(input.token_auth);
});

it('preserves existing access on failed or empty discovery', async () => {
  mocks.request.mockResolvedValueOnce(Response.json([]));
  expect((await post(input)).status).toBe(422);
  mocks.request.mockRejectedValueOnce(new Error(input.token_auth));
  const failed = await post(input);
  expect(failed.status).toBe(502); expect(await failed.text()).not.toContain(input.token_auth);
  expect(mocks.upsert).not.toHaveBeenCalled();
});

it('requires a same-origin owner or admin before contacting Matomo', async () => {
  expect((await post(input, 'https://another.example')).status).toBe(403);
  mocks.session.mockResolvedValueOnce({ organizationId: project, role: 'viewer' });
  expect((await post(input)).status).toBe(403);
  expect(mocks.request).not.toHaveBeenCalled();
});

it('requires a DNS domain for hosted instances', () => {
  for (const url of ['https://localhost', 'https://127.0.0.1', 'https://[::1]']) {
    expect(() => createHostedMatomoProvider({ url, tokenAuth: 'sample' })).toThrow(/publicly reachable/);
  }
});

it('accepts the configured app origin behind a reverse proxy', async () => {
  expect((await post(input, 'https://app.adport.test', 'http://localhost:3000')).status).toBe(200);
});

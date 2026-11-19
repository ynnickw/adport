import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), accounts: vi.fn(), upsert: vi.fn(), stage: vi.fn(), verify: vi.fn(), audit: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@adport/provider-openai', () => ({ OpenAIAdsClient: class {}, OpenAIAdsProvider: class { listAccounts = mocks.accounts; } }));
vi.mock('@/lib/cloud/repository', () => ({ upsertProviderConnection: mocks.upsert, setConnectionVerification: mocks.verify, recordAudit: mocks.audit }));
vi.mock('@/lib/cloud/account-selection', () => ({ stageAccountSelection: mocks.stage }));
import { POST } from '@/app/api/connections/[provider]/route';

const project = '11111111-1111-4111-8111-111111111111';
const key = 'test-advertiser-key';
const post = (body: unknown, origin = 'https://app.adport.test') => POST(new Request('https://app.adport.test/api/connections/openai', {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
}), { params: Promise.resolve({ provider: 'openai' }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ organizationId: project, userId: 'user', role: 'owner' });
  mocks.accounts.mockResolvedValue([{ provider: 'openai', id: 'adacct_123', name: 'Advertiser' }]);
  mocks.upsert.mockResolvedValue('connection'); mocks.stage.mockResolvedValue(undefined);
});
describe('OpenAI Advertiser connection', () => {
  it('verifies the key before storing it and requires normal account selection', async () => {
    const response = await post({ organization_id: project, api_key: key });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirect: expect.stringMatching(/^\/account-selection\?selection_id=/) });
    expect(mocks.accounts.mock.invocationCallOrder[0]).toBeLessThan(mocks.upsert.mock.invocationCallOrder[0]!);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ organizationId: project, provider: 'openai', credential: { apiKey: key }, scopes: [] }));
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai', connectionId: 'connection', accounts: [{ provider: 'openai', id: 'adacct_123', name: 'Advertiser' }] }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(key);
  });
  it('preserves the existing connection and keeps upstream secrets out of errors', async () => {
    mocks.accounts.mockRejectedValueOnce(new Error(`upstream echoed ${key}`));
    const response = await post({ organization_id: project, api_key: key });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain(key);
    expect(mocks.upsert).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'member'])('refuses %s access before using the key', async role => {
    mocks.session.mockResolvedValueOnce({ organizationId: project, role });
    expect((await post({ organization_id: project, api_key: key })).status).toBe(403);
    expect(mocks.accounts).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests and malformed input without storing or echoing a key', async () => {
    expect((await post({ organization_id: project, api_key: key }, 'https://untrusted.example')).status).toBe(403);
    const response = await post({ organization_id: project, api_key: key, unsupported: true });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(key);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

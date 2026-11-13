import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), connected: vi.fn(), create: vi.fn(), save: vi.fn(), revoke: vi.fn(),
}));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/repository', () => ({ createApiKey: mocks.create, revokeApiKey: mocks.revoke }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ connectedCatalogProviders: mocks.connected, saveToolSelection: mocks.save }));
import { POST } from '@/app/api/api-keys/route';

const project = '11111111-1111-4111-8111-111111111111';
const principal = { organizationId: project, userId: 'fixture-user', role: 'owner', scopes: ['tools:read'] };
const created = { id: 'fixture-key', key: 'test-key' };

function createKey(selection?: unknown) {
  return POST(new Request('https://app.adport.test/api/api-keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organization_id: project, name: 'Fixture', scopes: ['tools:read'], selection }),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(principal);
  mocks.create.mockResolvedValue(created);
});

it('defaults a new API key to Standard for its connected providers', async () => {
  mocks.connected.mockResolvedValue({ [project]: ['google', 'meta'] });
  expect((await createKey()).status).toBe(201);
  expect(mocks.connected).toHaveBeenCalledWith([project]);
  expect(mocks.save).toHaveBeenCalledWith({ ...principal, apiKeyId: created.id }, { profile: 'standard', providers: ['google', 'meta'] });
});

it('selects no providers when none are connected', async () => {
  mocks.connected.mockResolvedValue({});
  expect((await createKey()).status).toBe(201);
  expect(mocks.save).toHaveBeenCalledWith({ ...principal, apiKeyId: created.id }, { profile: 'standard', providers: [] });
});

it('honors an explicit Full selection across all providers', async () => {
  const selection = { profile: 'full', providers: null };
  expect((await createKey(selection)).status).toBe(201);
  expect(mocks.connected).not.toHaveBeenCalled();
  expect(mocks.save).toHaveBeenCalledWith({ ...principal, apiKeyId: created.id }, selection);
});

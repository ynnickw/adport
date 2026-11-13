import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), scope: vi.fn(), runtime: vi.fn(), call: vi.fn(), rate: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session, requireScope: mocks.scope }));
vi.mock('@/lib/cloud/catalog-access-runtime', () => ({ createCatalogAccessRuntime: mocks.runtime }));
vi.mock('@/lib/cloud/repository', () => ({ enforceRateLimit: mocks.rate }));
vi.mock('@/lib/env', () => ({ env: () => ({ ADPORT_CLOUD_BASE_URL: 'https://app.adport.test' }) }));
import { GET, POST } from '@/app/api/catalog-access/route';

const project = 'b310e750-d001-4427-8184-09bd05920e01', args = { organizationId: project, account_id: '123', bc_id: '456', catalog_id: '789', mode: 'read' }, hash = 'a'.repeat(64);
const request = (body: unknown, origin: string | null = 'https://app.adport.test') => new Request('https://app.adport.test/api/catalog-access', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();mocks.session.mockResolvedValue({ organizationId: project, userId: 'owner', role: 'owner', scopes: ['tools:read', 'connections:manage'] });mocks.rate.mockResolvedValue(true);mocks.runtime.mockResolvedValue({ registry: { call: mocks.call }, ctx: {} });
  mocks.call.mockImplementation(async (name: string) => name.endsWith('_catalog_access_snapshot') ? { grant: { hash } } : ['tiktok_catalog_access', 'reddit_catalog_access'].includes(name) ? { grants: [] } : { pending_operation_id: 'pending-access', preview: { review: { fields: [] } } });
});
describe('owner-only project catalog access route', () => {
  it('previews through the shared registry, binds current hash and returns exact arguments without applying', async () => {
    const response = await POST(request(args));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ arguments: { ...args, expected_access_hash: hash }, result: { pending_operation_id: 'pending-access' } });
    expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ organizationId: project }), '123');expect(mocks.call).toHaveBeenLastCalledWith('tiktok_set_catalog_access', { account_id: '123', bc_id: '456', catalog_id: '789', mode: 'read', expected_access_hash: hash }, {});expect(mocks.call.mock.calls.some(call => call[1].pending_operation_id)).toBe(false);
    expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), 'connections:manage');
  });
  it('routes creation delegation through the same owner-only preview/apply path without an invented catalog ID', async () => {
    const creation = { organizationId: project, account_id: '123', bc_id: '456', resource_kind: 'catalog_creation', mode: 'create' };
    const response = await POST(request(creation));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ arguments: { ...creation, expected_access_hash: hash } });expect(mocks.call).toHaveBeenCalledWith('tiktok_catalog_access_snapshot', { account_id: '123', bc_id: '456', resource_kind: 'catalog_creation' }, {});expect(mocks.call).toHaveBeenLastCalledWith('tiktok_set_catalog_access', { account_id: '123', bc_id: '456', resource_kind: 'catalog_creation', mode: 'create', expected_access_hash: hash }, {});
    mocks.call.mockClear();expect((await POST(request({ ...creation, expected_access_hash: hash, pending_operation_id: 'approved' }))).status).toBe(200);expect(mocks.call).toHaveBeenCalledTimes(1);expect(mocks.call.mock.calls[0]![1]).not.toHaveProperty('catalog_id');
  });
  it.each([{ resource_kind: 'catalog_creation', mode: 'write' }, { resource_kind: 'catalog_creation', mode: 'create' }, { mode: 'create' }])('rejects contradictory catalog/creation selection %j', async patch => {
    expect((await POST(request({ ...args, ...patch }))).status).toBe(400);expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it('routes Reddit Business/catalog grants explicitly and leaves legacy TikTok routing unchanged', async () => {
    const business = '1e200a0b-4e98-32cc-dd47-3006e4c85bb2', selected = { organizationId: project, account_id: 'a2_qa', provider: 'reddit', business_id: business, catalog_id: 'catalog_qa', mode: 'write' };
    const response = await POST(request(selected));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ arguments: { ...selected, expected_access_hash: hash } });expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ organizationId: project }), 'a2_qa', 'reddit');expect(mocks.call).toHaveBeenLastCalledWith('reddit_set_catalog_access', { account_id: 'a2_qa', business_id: business, catalog_id: 'catalog_qa', mode: 'write', expected_access_hash: hash }, {});
    mocks.call.mockClear();const listing = await GET(new Request(`https://app.adport.test/api/catalog-access?organizationId=${project}&account_id=a2_qa&provider=reddit`));expect(await listing.json()).toMatchObject({ provider: 'reddit', account_id: 'a2_qa' });expect(mocks.call).toHaveBeenCalledWith('reddit_catalog_access', { account_id: 'a2_qa' }, {});
    mocks.call.mockClear();const creation = { ...selected, resource_kind: 'catalog_creation', catalog_id: undefined, mode: 'create', expected_access_hash: hash, pending_operation_id: 'approved' };expect((await POST(request(creation))).status).toBe(200);expect(mocks.call).toHaveBeenCalledTimes(1);expect(mocks.call.mock.calls[0]![0]).toBe('reddit_set_catalog_access');expect(mocks.call.mock.calls[0]![1]).not.toHaveProperty('bc_id');
  });
  it.each([{ provider: 'reddit', bc_id: '456' }, { provider: 'reddit', business_id: 'not-a-business' }, { provider: 'x' }, { business_id: '1e200a0b-4e98-32cc-dd47-3006e4c85bb2' }])('rejects mixed or invalid platform authority %j', async patch => {
    expect((await POST(request({ ...args, ...patch }))).status).toBe(400);expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it('applies only an exact supplied pending token/hash and never prepares a replacement silently', async () => {
    const response = await POST(request({ ...args, expected_access_hash: hash, pending_operation_id: 'approved' }));expect(response.status).toBe(200);expect(mocks.call).toHaveBeenCalledTimes(1);expect(mocks.call).toHaveBeenCalledWith('tiktok_set_catalog_access', { account_id: '123', bc_id: '456', catalog_id: '789', mode: 'read', expected_access_hash: hash, pending_operation_id: 'approved' }, {});
    mocks.call.mockClear();expect((await POST(request({ ...args, pending_operation_id: 'unbound' }))).status).toBe(400);expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each([null, 'https://other.example.test'])('rejects origin %s before authentication or native work', async origin => {
    expect((await POST(request(args, origin))).status).toBe(403);expect(mocks.session).not.toHaveBeenCalled();expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it.each([{ role: 'member' }, { role: 'viewer' }, { apiKeyId: 'owner-key' }, { clientId: 'owner-oauth' }, { oauthTokenId: 'owner-token' }, { userId: undefined }])('rejects non-session administration %o', async patch => {
    mocks.session.mockResolvedValue({ organizationId: project, userId: 'owner', role: 'owner', scopes: ['tools:read', 'connections:manage'], ...patch });expect((await POST(request(args))).status).toBe(403);expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it('rejects oversized bodies, unknown tool/authority fields and rate-limit failures', async () => {
    expect((await POST(request({ ...args, tool: 'tiktok_create_campaign' }))).status).toBe(400);expect(mocks.runtime).not.toHaveBeenCalled();
    const large = new Request('https://app.adport.test/api/catalog-access', { method: 'POST', headers: { origin: 'https://app.adport.test' }, body: JSON.stringify({ ...args, data: 'x'.repeat(5000) }) });expect((await POST(large)).status).toBe(413);
    mocks.rate.mockResolvedValue(false);expect((await POST(request(args))).status).toBe(429);expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it('reads only the selected project/account and forbids GET parameters that could request native discovery', async () => {
    const response = await GET(new Request(`https://app.adport.test/api/catalog-access?organizationId=${project}&account_id=123`));expect(response.status).toBe(200);expect(mocks.session).toHaveBeenCalledWith(project);expect(mocks.call).toHaveBeenCalledWith('tiktok_catalog_access', { account_id: '123' }, {});
    mocks.call.mockClear();expect((await GET(new Request(`https://app.adport.test/api/catalog-access?organizationId=${project}&account_id=123&bc_id=456`))).status).toBe(400);expect(mocks.call).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), grants: vi.fn(), save: vi.fn(), sql: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ listMcpOAuthGrants: mocks.grants }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ saveToolSelection: mocks.save }));
vi.mock('@/lib/db', () => ({ db: () => mocks.sql }));
import { PATCH } from '@/app/api/assistant-connections/catalog/route';

const project = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const grant = { userId: user, clientId: 'client', resource: 'https://app.adport.test/mcp', organizationGroupId: null, status: 'active' };
const connection = { type: 'oauth', client_id: grant.clientId, user_id: user, resource: grant.resource, organization_group_id: null };
const selection = { profile: 'standard', providers: ['meta'] };
const patch = (body: unknown) => PATCH(new Request('https://app.adport.test/api/assistant-connections/catalog', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ organizationId: project, userId: user, role: 'owner' });
  mocks.grants.mockResolvedValue([grant]); mocks.save.mockResolvedValue(undefined); mocks.sql.mockResolvedValue([]);
});
describe('assistant catalog settings authorization', () => {
  it('persists an explicit selection for the current user’s active connection', async () => {
    expect((await patch({ organization_id: project, connection, selection })).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ organizationId: project, userId: user, clientId: 'client', resource: grant.resource }), selection);
  });
  it('preserves an intentionally empty platform selection', async () => {
    expect((await patch({ organization_id: project, connection, selection: { ...selection, providers: [] } })).status).toBe(200);
    expect(mocks.save.mock.calls[0]![1].providers).toEqual([]);
  });
  it('rejects another user even when the project administrator can see their grant', async () => {
    expect((await patch({ organization_id: project, connection: { ...connection, user_id: '33333333-3333-4333-8333-333333333333' }, selection })).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(['member', 'viewer'])('rejects a %s', async role => {
    mocks.session.mockResolvedValue({ organizationId: project, userId: user, role });
    expect((await patch({ organization_id: project, connection, selection })).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects inactive grants and forged organization scopes', async () => {
    mocks.grants.mockResolvedValue([{ ...grant, status: 'revoked' }]);
    expect((await patch({ organization_id: project, connection, selection })).status).toBe(404);
    mocks.grants.mockResolvedValue([grant]);
    expect((await patch({ organization_id: project, connection: { ...connection, organization_group_id: project }, selection })).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects unknown platforms and API keys from another project', async () => {
    expect((await patch({ organization_id: project, connection, selection: { ...selection, providers: ['unknown'] } })).status).toBe(400);
    expect((await patch({ organization_id: project, connection: { type: 'key', id: user }, selection })).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

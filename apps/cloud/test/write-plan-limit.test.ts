import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantPrincipal } from '@/lib/cloud/types';
import { HttpError } from '@/lib/http';

const mocks = vi.hoisted(() => ({ principal: vi.fn(), membership: vi.fn(), call: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ principalToolSelection: async () => ({ profile: 'full', providers: null }) }));
vi.mock('@/lib/db', () => ({ db: () => mocks.membership }));
vi.mock('@/lib/cloud/auth', () => ({
  apiPrincipal: mocks.principal,
  requireScope: (principal: TenantPrincipal, scope: string) => { if (!principal.scopes.includes(scope as never)) throw new HttpError('Missing required scope.', 403); },
}));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: async () => ({ registry: { get: mocks.get, call: mocks.call }, ctx: {} }) }));
import { POST } from '@/app/api/v1/tools/[tool]/route';

const principal: TenantPrincipal = { organizationId: 'project', userId: 'user', role: 'owner', scopes: ['tools:read'], grantedScopes: ['tools:read', 'tools:write'], entitlement: { planId: 'reader', planName: 'Free', writeAccess: false } };
const invoke = () => POST(new Request('https://app.adport.test/api/v1/tools/campaign_pause', { method: 'POST', body: '{}' }), { params: Promise.resolve({ tool: 'campaign_pause' }) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue(principal);
  mocks.membership.mockResolvedValue([{ role: 'owner' }]);
  mocks.get.mockReturnValue({ annotations: { readOnly: false } });
  mocks.call.mockResolvedValue({ preview: true });
});

describe('REST write entitlement denial', () => {
  it('returns a clear, priced 402 upgrade response before running a Free write', async () => {
    const response = await invoke();
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'PLAN_LIMIT', planLimit: { kind: 'write_access', recommendedPlan: 'operator', canManageBilling: true } });
    expect(body.error).toContain('Pro (€19/month)');
    expect(new URL(body.planLimit.upgradeUrl).searchParams.get('projectId')).toBe('project');
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'read-only credential', 'paid member without a seat'])('keeps %s as a permission denial without an upsell', async reason => {
    mocks.principal.mockResolvedValue({ ...principal, ...(reason === 'viewer' ? { role: 'viewer' } : reason === 'read-only credential' ? { grantedScopes: ['tools:read'] } : { entitlement: { planId: 'operator', planName: 'Pro', writeAccess: true } }) });
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('planLimit');
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it('keeps reads available on Free and preserves the authorized write path', async () => {
    mocks.get.mockReturnValue({ annotations: { readOnly: true } });
    expect((await invoke()).status).toBe(200);
    expect(mocks.call).toHaveBeenCalledOnce();
    mocks.get.mockReturnValue({ annotations: { readOnly: false } });
    mocks.principal.mockResolvedValue({ ...principal, scopes: ['tools:read', 'tools:write'], entitlement: { planId: 'operator', planName: 'Pro', writeAccess: true } });
    expect((await invoke()).status).toBe(200);
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as start } from '@/app/api/oauth/[provider]/start/route';
import { GET as callback } from '@/app/api/oauth/[provider]/callback/route';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { resetEnvForTests } from '@/lib/env';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), create: vi.fn(), consume: vi.fn(), upsert: vi.fn(), audit: vi.fn(), verify: vi.fn(), sync: vi.fn(), list: vi.fn(),
}));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/account-selection', () => ({ stageAccountSelection: mocks.sync }));
vi.mock('@/lib/cloud/repository', () => ({ createOAuthTransaction: mocks.create, consumeOAuthTransaction: mocks.consume, upsertProviderConnection: mocks.upsert, recordAudit: mocks.audit, setConnectionVerification: mocks.verify, syncDiscoveredAccounts: mocks.sync }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: async () => ({ ctx: { providers: { get: () => ({ listAccounts: mocks.list }) } } }) }));
vi.mock('@/lib/cloud/plans', () => ({ getOrganizationEntitlement: async () => ({ plan: { id: 'reader', maxActiveAccounts: 3 } }) }));
const principal = { userId: 'initiator', organizationId: 'org', role: 'owner', scopes: [] };
const context = () => ({ params: Promise.resolve({ provider: 'x' }) });
const returned = () => new Request('https://untrusted-host.test/api/oauth/x/callback?oauth_token=temporary-token&oauth_verifier=provider-verifier');

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ADPORT_CLOUD_BASE_URL', 'https://app.adport.test');
  vi.stubEnv('X_CONSUMER_KEY', 'app-key'); vi.stubEnv('X_CONSUMER_SECRET', 'app-secret'); vi.stubEnv('X_OAUTH_ENABLED', 'true');
  resetEnvForTests();
  mocks.session.mockResolvedValue(principal);
  mocks.list.mockResolvedValue([]); mocks.sync.mockResolvedValue([]);
  mocks.create.mockResolvedValue(undefined); mocks.upsert.mockResolvedValue('connection'); mocks.audit.mockResolvedValue(undefined);
  mocks.consume.mockResolvedValue({ organizationId: 'org', verifier: 'temporary-secret', returnPath: '/dashboard/connections' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetEnvForTests(); });

describe('X hosted onboarding boundaries', () => {
  it('denies starts and callback exchanges outside the test organization', async () => {
    vi.stubEnv('ADPORT_PROVIDER_TEST_ORGANIZATION_IDS', 'different-org'); resetEnvForTests();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const response = await start(new Request('https://app.adport.test/api/oauth/x/start?organization_id=org'), context());
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect((await callback(returned(), context())).headers.get('location')).toContain('error=');
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('stores the temporary token and secret before redirecting, without leaking the secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('oauth_token=temporary-token&oauth_token_secret=temporary-secret&oauth_callback_confirmed=true'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await start(new Request('https://untrusted-host.test/api/oauth/x/start?organization_id=org'), context());
    expect(response.status).toBe(307);
    expect(mocks.session).toHaveBeenCalledWith('org');
    expect(mocks.create).toHaveBeenCalledWith({ organizationId: 'org', userId: 'initiator', provider: 'x', state: 'temporary-token', verifier: 'temporary-secret', returnPath: '/dashboard/accounts?select_provider=x' });
    expect(response.headers.get('location')).toBe('https://api.x.com/oauth/authorize?oauth_token=temporary-token');
    expect(response.headers.get('location')).not.toContain('secret');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const header = new Headers(init.headers).get('authorization')!;
    expect(decodeURIComponent(header)).toContain('https://app.adport.test/api/oauth/x/callback');
    expect(header).not.toContain('untrusted-host');
  });

  it('does not request temporary credentials for non-admins or a disabled deployment', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    mocks.session.mockResolvedValue({ ...principal, role: 'viewer' });
    expect((await start(new Request('https://app.adport.test/api/oauth/x/start'), context())).status).toBe(401);
    mocks.session.mockResolvedValue(principal);
    vi.stubEnv('X_OAUTH_ENABLED', 'false'); resetEnvForTests();
    expect((await start(new Request('https://app.adport.test/api/oauth/x/start'), context())).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not redirect when saving the encrypted transaction fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oauth_token=temporary-token&oauth_token_secret=temporary-secret&oauth_callback_confirmed=true')));
    mocks.create.mockRejectedValue(new Error('transaction unavailable'));
    const response = await start(new Request('https://app.adport.test/api/oauth/x/start'), context());
    expect(response.headers.has('location')).toBe(false);
  });

  it('exchanges only after user binding and organization role checks, verifying the grant and applying the existing account-plan limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('oauth_token=tenant-token&oauth_token_secret=tenant-secret&user_id=123&screen_name=fixture'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await callback(returned(), context());
    expect(mocks.consume).toHaveBeenCalledWith('x', 'temporary-token', 'initiator');
    expect(mocks.session.mock.calls).toEqual([[], ['org']]);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ provider: 'x', organizationId: 'org', userId: 'initiator',
      credential: { accessToken: 'tenant-token', accessTokenSecret: 'tenant-secret' },
    }));
    expect(mocks.consume.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(mocks.session.mock.invocationCallOrder[1]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
    expect(response.headers.get('location')).toMatch(/^https:\/\/app.adport.test\/account-selection\?selection_id=/);
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({ principal, provider: 'x', accounts: [], returnPath: '/dashboard/connections' }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('tenant-secret');
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('tenant-token');
  });

  it.each(['foreign user', 'expired state', 'replayed state', 'unknown request token'])('does not exchange when the transaction rejects %s', async reason => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    mocks.consume.mockRejectedValue(new Error(reason));
    const response = await callback(returned(), context());
    expect(response.headers.get('location')).toContain('error=');
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('does not exchange after the user loses administrator access during consent', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    mocks.session.mockResolvedValueOnce(principal).mockResolvedValueOnce({ ...principal, role: 'member' });
    await callback(returned(), context());
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it.each([
    'code=oauth2-code&state=oauth2-state',
    'oauth_token=temporary-token',
    'denied=temporary-token',
    'oauth_token=temporary-token&oauth_token=other&oauth_verifier=v',
    'oauth_token=temporary-token&oauth_verifier=v&oauth_verifier=other',
  ])('rejects incomplete, denied or ambiguous callbacks: %s', async query => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await callback(new Request(`https://app.adport.test/api/oauth/x/callback?${query}`), context());
    expect(mocks.consume).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('fails closed if deployment access is disabled while consent is in progress', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('X_OAUTH_ENABLED', 'false'); resetEnvForTests();
    await callback(returned(), context());
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('confirms provider-side revocation and propagates transient failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'tenant-token' })).mockResolvedValueOnce(new Response('upstream-secret', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const grant = { accessToken: 'tenant-token', accessTokenSecret: 'tenant-secret' };
    await expect(oauthAdapter('x').revoke(grant)).resolves.toBe(true);
    await expect(oauthAdapter('x').revoke(grant)).rejects.toThrow(/HTTP 503/);
  });
});

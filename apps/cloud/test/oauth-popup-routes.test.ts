import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as start } from '@/app/api/oauth/[provider]/start/route';
import { GET as callback } from '@/app/api/oauth/[provider]/callback/route';
import { OAUTH_PROVIDERS } from '@/lib/cloud/types';
import { popupReturnPath } from '@/lib/oauth-popup';
import { resetEnvForTests } from '@/lib/env';

const mocks = vi.hoisted(() => ({ session: vi.fn(), create: vi.fn(), consume: vi.fn(), exchange: vi.fn(), stage: vi.fn(), list: vi.fn(), adapter: vi.fn(), upsert: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/provider-rollout', () => ({ providerAllowedForOrganization: () => true }));
vi.mock('@/lib/cloud/provider-oauth', () => ({ oauthAdapter: mocks.adapter }));
vi.mock('@/lib/cloud/account-selection', () => ({ stageAccountSelection: mocks.stage }));
vi.mock('@/lib/cloud/repository', () => ({ createOAuthTransaction: mocks.create, consumeOAuthTransaction: mocks.consume,
  recordAudit: vi.fn(), setConnectionVerification: vi.fn(), updateProviderCredential: vi.fn(), upsertProviderConnection: mocks.upsert }));
vi.mock('@/lib/cloud/runtime', () => ({ createTenantRuntime: async () => ({ ctx: { providers: { get: () => ({ listAccounts: mocks.list }) } } }) }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv('ADPORT_CLOUD_BASE_URL', 'https://app.adport.test'); resetEnvForTests();
  mocks.session.mockResolvedValue({ userId: 'user', organizationId: 'org', role: 'owner' });
  mocks.consume.mockResolvedValue({ organizationId: 'org', verifier: 'secret', returnPath: popupReturnPath(id, '/onboarding') });
  mocks.exchange.mockResolvedValue({ accessToken: 'secret' }); mocks.list.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue('connection');
  mocks.adapter.mockImplementation((_provider, options) => ({ configured: () => true, codeParam: 'code', scopes: options?.googleDataManager ? ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager'] : [], authorizationUrl: () => 'https://provider.test/authorize', exchange: mocks.exchange }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetEnvForTests(); });

describe('shared popup OAuth routes', () => {
  it('binds the Google Data Manager opt-in to the server-side transaction and uses it on callback', async () => {
    const context = { params: Promise.resolve({ provider: 'google' }) };
    await start(new Request('https://app.adport.test/api/oauth/google/start?data_manager=1'), context);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', googleDataManager: true }));
    mocks.consume.mockResolvedValue({ organizationId: 'org', verifier: 'secret', returnPath: '/dashboard/connections', googleDataManager: true });
    await callback(new Request('https://app.adport.test/api/oauth/google/callback?code=code&state=verified'), context);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/datamanager'] }));
  });
  it('ignores forged callback scope options and preserves the old connection when exchange fails', async () => {
    const context = { params: Promise.resolve({ provider: 'google' }) };
    await callback(new Request('https://app.adport.test/api/oauth/google/callback?code=code&state=verified&data_manager=1'), context);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ scopes: [] }));
    mocks.upsert.mockClear(); mocks.exchange.mockRejectedValue(new Error('Scope not granted'));
    await callback(new Request('https://app.adport.test/api/oauth/google/callback?code=code&state=verified'), context);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it.each(['google/start?data_manager=0', 'google/start?data_manager=1&data_manager=1', 'meta/start?data_manager=1'])('rejects an ambiguous or non-Google scope request: %s', async suffix => {
    const response = await start(new Request(`https://app.adport.test/api/oauth/${suffix}`), { params: Promise.resolve({ provider: suffix.startsWith('meta') ? 'meta' : 'google' }) });
    expect(response.status).toBe(400); expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(OAUTH_PROVIDERS)('binds %s popup delivery to the server-side transaction', async provider => {
    const context = { params: Promise.resolve({ provider }) };
    const response = await start(new Request(`https://untrusted.test/api/oauth/${provider}/start?popup_id=${id}&return_to=%2Fonboarding`), context);
    expect(response.headers.get('location')).toBe('https://provider.test/authorize');
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ returnPath: popupReturnPath(id, '/onboarding') }));
    const result = await callback(new Request(`https://untrusted.test/api/oauth/${provider}/callback?code=code&state=state`), context);
    const location = new URL(result.headers.get('location')!);
    expect(location.origin).toBe('https://app.adport.test'); expect(location.pathname).toBe('/oauth/provider-complete');
    expect(location.searchParams.get('popup_id')).toBe(id);
    expect(location.searchParams.get('next')).toMatch(/^\/account-selection\?selection_id=/);
    expect(location.toString()).not.toContain('secret');
    expect(mocks.stage).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/onboarding' }));
  });
  it('returns start failures to the popup without leaking exception details', async () => {
    mocks.session.mockRejectedValue(new Error('secret'));
    const result = await start(new Request(`https://app.adport.test/api/oauth/x/start?popup_id=${id}`), { params: Promise.resolve({ provider: 'x' }) });
    expect(result.headers.get('location')).toContain('/oauth/provider-complete?');
    expect(result.headers.get('location')).not.toContain('secret');
  });
  it('returns verification errors to the same popup and original screen', async () => {
    mocks.list.mockRejectedValue(new Error('Account verification failed'));
    const result = await callback(new Request('https://app.adport.test/api/oauth/x/callback?code=code&state=state'), { params: Promise.resolve({ provider: 'x' }) });
    const location = new URL(result.headers.get('location')!);
    expect(location.pathname).toBe('/oauth/provider-complete');
    expect(location.searchParams.get('next')).toMatch(/^\/onboarding\?error=/);
  });
  it('ignores invalid popup IDs and retains same-tab redirects', async () => {
    await start(new Request('https://app.adport.test/api/oauth/x/start?popup_id=invalid'), { params: Promise.resolve({ provider: 'x' }) });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ returnPath: '/dashboard/accounts?select_provider=x' }));
  });
});

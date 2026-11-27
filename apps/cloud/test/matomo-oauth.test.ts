import { afterEach, expect, it, vi } from 'vitest';
import { resetEnvForTests } from '@/lib/env';
import { matomoApplication, matomoOAuth, matomoTokens } from '@/lib/cloud/matomo-oauth';
import { GET, POST } from '@/app/api/oauth/[provider]/start/route';

const mocks = vi.hoisted(() => ({ send: vi.fn(), session: vi.fn(), previous: vi.fn(), create: vi.fn() }));
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: mocks.send }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/repository', () => ({ loadProviderCredential: mocks.previous, createOAuthTransaction: mocks.create }));

const url = 'https://analytics.example.test/site';
const app = { url, clientId: 'client', clientSecret: 'test-only' };
const organization = 'b4624aa0-9be5-43b8-8171-d13208285e9c';
const params = { params: Promise.resolve({ provider: 'matomo' }) };
const response = { access_token: 'initial-access', refresh_token: 'initial-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'matomo:read' };
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); resetEnvForTests(); });

it('binds the confidential registration and verifier to the signed-in project, outside browser URLs', async () => {
  vi.stubEnv('ADPORT_CLOUD_BASE_URL', 'https://app.example.test'); resetEnvForTests();
  mocks.session.mockResolvedValue({ organizationId: organization, userId: 'user', role: 'admin' });
  const req = (origin: string) => new Request('https://app.example.test/api/oauth/matomo/start', { method: 'POST', headers: { origin },
    body: JSON.stringify({ url, organization_id: organization, client_id: app.clientId, client_secret: app.clientSecret }) });
  expect((await GET(req('https://app.example.test'), params)).status).toBe(400);
  expect((await POST(req('https://foreign.example.test'), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  const result = await POST(req('https://app.example.test'), params);
  expect(result.status).toBe(200);
  const auth = new URL((await result.json()).redirect);
  expect(auth.href).not.toContain('test-only');
  expect(auth.pathname).toBe('/site/index.php');
  expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: 'client', scope: 'matomo:read', code_challenge_method: 'S256',
    redirect_uri: 'https://app.example.test/api/oauth/matomo/callback' });
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'matomo', matomoApplication: app, state: auth.searchParams.get('state'), organizationId: organization }));
  expect(mocks.create.mock.calls[0]![0].verifier).not.toBe(auth.searchParams.get('code_challenge'));
});

it('uses the selected instance for code exchange, verifies actual bearer access, and handles rotating or retained refresh tokens', async () => {
  mocks.send.mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(Response.json([{ idsite: 1, name: 'Shop' }]));
  const grant = await matomoOAuth(app).exchange({ code: 'code', state: 'state', verifier: 'verifier' });
  expect(grant).toMatchObject({ ...app, accessToken: 'initial-access', refreshToken: 'initial-refresh' });
  const [tokenUrl, exchange] = mocks.send.mock.calls[0]!;
  const [reportUrl, report] = mocks.send.mock.calls[1]!;
  expect(tokenUrl).toBe(url + '/index.php?module=OAuth2&action=token');
  expect(Object.fromEntries(exchange.body)).toMatchObject({ client_secret: app.clientSecret, code_verifier: 'verifier', grant_type: 'authorization_code' });
  expect(reportUrl).toBe(url + '/index.php');
  expect(new Headers(report.headers).get('authorization')).toBe('Bearer initial-access');
  expect(report.body.has('token_auth')).toBe(false);
  for (const replacement of [undefined, 'rotated']) {
    mocks.send.mockResolvedValueOnce(Response.json({ ...response, refresh_token: replacement }));
    const renewed = await matomoTokens(app, { grant_type: 'refresh_token', refresh_token: 'old' });
    expect(renewed.refreshToken).toBe(replacement ?? 'old');
  }
});

it('keeps client secrets instance-bound and rejects excess scopes or anonymous grants', async () => {
  const previous = { ...app, grantId: 'id', accessToken: 'access', refreshToken: 'refresh', expiresAt: 1 };
  expect(matomoApplication(url + '/', undefined, previous)).toEqual(app);
  expect(() => matomoApplication(url + '/different', undefined, previous)).toThrow(/Register/);
  expect(() => matomoApplication('https://127.0.0.1', app)).toThrow();
  mocks.send.mockResolvedValueOnce(Response.json({ ...response, scope: 'matomo:write' }));
  await expect(matomoTokens(app, {})).rejects.toThrow(/read-only/);
  mocks.send.mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(Response.json([]));
  await expect(matomoOAuth(app).exchange({ code: 'code', state: '', verifier: 'v' })).rejects.toThrow(/visible sites/);
});

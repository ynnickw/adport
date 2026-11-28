import { afterEach, expect, it, vi } from 'vitest';
import { gravityOAuth, gravityClientMetadata, refreshGravity } from '@/lib/cloud/gravity-oauth';
import { GET } from '@/app/oauth/clients/gravity/route';

const { wire, account } = vi.hoisted(() => ({ wire: vi.fn(), account: vi.fn() }));
vi.mock('@/lib/cloud/gravity-mcp', () => ({ GRAVITY_RESOURCE: 'https://platform.trygravity.ai/mcp',
  GravityMcpTransport: class { get = account; } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
const token = (scope?: string) => Response.json({ access_token: 'access', refresh_token: 'rotated', expires_in: 3600, token_type: 'Bearer', scope });

it('publishes public client metadata and requests only the chosen resource and permissions', async () => {
  const meta = await GET().json();
  expect(meta).toEqual(gravityClientMetadata());
  expect(meta).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code','refresh_token'] });
  const auth = new URL(gravityOAuth().authorizationUrl({ state: 'state', challenge: 'challenge' }));
  expect(auth.origin + auth.pathname).toBe('https://platform.trygravity.ai/oauth/authorize');
  expect(Object.fromEntries(auth.searchParams)).toMatchObject({ client_id: meta.client_id, redirect_uri: meta.redirect_uris[0],
    resource: 'https://platform.trygravity.ai/mcp', scope: 'read', code_challenge_method: 'S256' });
});

it('preserves a narrower grant and confirms the chosen advertiser before storing it', async () => {
  vi.stubGlobal('fetch', wire); wire.mockResolvedValueOnce(token('read'));
  account.mockResolvedValueOnce({ advertiser_id: 'selected', name: 'Brand' });
  const oauth = gravityOAuth('spend');
  const grant = await oauth.exchange({ code: 'code', verifier: 'verifier' });
  expect(grant).toMatchObject({ scopes: ['read'], refreshToken: 'rotated' });
  const [address, input] = wire.mock.calls[0]!;
  expect(address).toBe('https://platform.trygravity.ai/oauth/token');
  expect(Object.fromEntries(input.body)).toMatchObject({ code_verifier: 'verifier', grant_type: 'authorization_code', resource: 'https://platform.trygravity.ai/mcp' });
  expect(input.body.has('client_secret')).toBe(false);
  for (const scope of ['admin', 'read spend', 'read write admin']) {
    wire.mockResolvedValueOnce(token(scope)); await expect(oauth.exchange({ code: 'code', verifier: 'verifier' })).rejects.toThrow(/scope/);
  }
  expect(account).toHaveBeenCalledTimes(1);
  wire.mockResolvedValueOnce(token('read')); account.mockRejectedValueOnce(new Error('Advertiser unavailable'));
  await expect(oauth.exchange({ code: 'code', verifier: 'verifier' })).rejects.toThrow(/Advertiser/);
});

it('refreshes only for the MCP resource and checks both revocations', async () => {
  vi.stubGlobal('fetch', wire); wire.mockResolvedValueOnce(token('read write'));
  await expect(refreshGravity('refresh', ['read','write'])).resolves.toMatchObject({ refreshToken: 'rotated' });
  expect(Object.fromEntries(wire.mock.calls[0]![1].body)).toMatchObject({ refresh_token: 'refresh', resource: 'https://platform.trygravity.ai/mcp' });
  wire.mockResolvedValueOnce(token('read'));
  await expect(refreshGravity('refresh', ['read','write'])).rejects.toThrow(/permissions changed/);
  const grant = { scopes: ['read'], accessToken: 'access', grantId: 'grant', expiresAt: 1, refreshToken: 'refresh' };
  wire.mockResolvedValueOnce(new Response()).mockResolvedValueOnce(new Response());
  await expect(gravityOAuth().revoke(grant)).resolves.toBe(true);
  expect(wire.mock.calls.slice(-2).map(([url, init]) => [url, init.body.get('token_type_hint')])).toEqual([
    ['https://platform.trygravity.ai/oauth/revoke','refresh_token'], ['https://platform.trygravity.ai/oauth/revoke','access_token'] ]);
  wire.mockResolvedValueOnce(new Response(null,{status:503}));
  await expect(gravityOAuth().revoke(grant)).rejects.toThrow(/revocation/);
});

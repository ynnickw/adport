import 'server-only';
import { randomUUID } from 'node:crypto';
import { GravityProvider } from '@adport/provider-gravity';
import { env } from '@/lib/env';
import { requestGrantTokens } from './hosted-grant';
import { GravityMcpTransport, GRAVITY_RESOURCE } from './gravity-mcp';
import type { OAuthAdapter } from './provider-oauth';

export const GRAVITY_ISSUER = 'https://platform.trygravity.ai';
export type GravityAccess = 'read' | 'write' | 'spend';
export function gravityClientMetadata() {
  const origin = env().ADPORT_CLOUD_BASE_URL;
  return { client_id: new URL('/oauth/clients/gravity', origin).href, client_name: 'Adport',
    client_uri: new URL('/', origin).href, redirect_uris: [new URL('/api/oauth/gravity/callback', origin).href],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
}

function validateScopes(granted: string[] | undefined, requested: string[]): string[] {
  const scopes = [...new Set(granted ?? requested)];
  if (!scopes.includes('read') || scopes.some(scope => !requested.includes(scope)) || (scopes.includes('spend') && !scopes.includes('write'))) {
    throw new Error('Gravity returned an unexpected scope. Reconnect and choose advertiser access.');
  }
  return scopes;
}

export async function refreshGravity(refreshToken: string, scopes: string[]) {
  const tokens = await requestGrantTokens(GRAVITY_ISSUER + '/oauth/token', new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: gravityClientMetadata().client_id, resource: GRAVITY_RESOURCE }));
  const granted = validateScopes(tokens.scopes, scopes);
  if (granted.length !== scopes.length) throw new Error('Gravity permissions changed. Reconnect to confirm the new access level.');
  return tokens;
}

export function gravityOAuth(access: GravityAccess = 'read'): OAuthAdapter<'gravity'> {
  const scopes = access === 'spend' ? ['read', 'write', 'spend'] : access === 'write' ? ['read', 'write'] : ['read'];
  return { provider: 'gravity', flowLabel: 'Gravity advertiser OAuth', pkce: true, codeParam: 'code', scopes,
    configured: () => true, manualRevocationUrl: 'https://app.trygravity.com',
    authorizationUrl({ state, challenge }) {
      const client = gravityClientMetadata();
      const url = new URL('/oauth/authorize', GRAVITY_ISSUER);
      url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, resource: GRAVITY_RESOURCE,
        response_type: 'code', state, scope: scopes.join(' '), code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    async exchange({ code, verifier }) {
      const client = gravityClientMetadata();
      const { scopes: returned, ...tokens } = await requestGrantTokens(GRAVITY_ISSUER + '/oauth/token', new URLSearchParams({
        client_id: client.client_id, redirect_uri: client.redirect_uris[0]!, resource: GRAVITY_RESOURCE,
        grant_type: 'authorization_code', code, code_verifier: verifier }));
      const granted = validateScopes(returned, scopes);
      const provider = new GravityProvider(new GravityMcpTransport(async () => tokens.accessToken), granted);
      await provider.listAccounts();
      return { ...tokens, scopes: granted, grantId: randomUUID() };
    },
    async revoke(grant) {
      if (!('grantId' in grant)) return false;
      for (const [type, token] of [['refresh_token', grant.refreshToken], ['access_token', grant.accessToken]] as const) {
        const response = await fetch(GRAVITY_ISSUER + '/oauth/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
          body: new URLSearchParams({ token, token_type_hint: type, client_id: gravityClientMetadata().client_id }) });
        if (!response.ok) throw new Error('Gravity did not confirm revocation. Retry disconnecting.');
      }
      return true;
    },
  };
}

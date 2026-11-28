import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { createHostedMatomoProvider, hostedMatomoUrl, matomoFetch } from './matomo';
import { requestGrantTokens } from './hosted-grant';
import type { OAuthAdapter } from './provider-oauth';
import type { MatomoApplication, ProviderCredentialMap } from './types';

const credentials = z.object({ clientId: z.string().trim().min(1).max(512), clientSecret: z.string().min(1).max(4096) });
const scope = 'matomo:read';

export function matomoApplication(url: string, supplied?: z.infer<typeof credentials>, previous?: ProviderCredentialMap['matomo']): MatomoApplication {
  const instance = hostedMatomoUrl(url);
  if (supplied) return { url: instance, ...credentials.parse(supplied) };
  const configured = JSON.parse(env().MATOMO_OAUTH_APPLICATIONS ?? '{}') as Record<string, unknown>;
  if (Object.hasOwn(configured, instance)) return { url: instance, ...credentials.parse(configured[instance]) };
  if (previous && 'grantId' in previous && previous.url === instance) {
    return { url: instance, clientId: previous.clientId, clientSecret: previous.clientSecret };
  }
  throw new Error('Register a confidential OAuth client on this Matomo instance and enter its client ID and secret.');
}

function endpoint(app: MatomoApplication, action: 'authorize' | 'token') {
  return new URL(hostedMatomoUrl(app.url) + '/index.php?module=OAuth2&action=' + action);
}

export async function matomoTokens(app: MatomoApplication, values: Record<string, string>) {
  const form = new URLSearchParams({ ...values, client_id: app.clientId, client_secret: app.clientSecret });
  const { scopes, ...tokens } = await requestGrantTokens(endpoint(app, 'token').href, form, matomoFetch);
  if (scopes && (scopes.length !== 1 || scopes[0] !== scope)) throw new Error('Matomo did not grant the requested read-only scope.');
  return tokens;
}

export function matomoRedirectUri(instance: string): string {
  const url = new URL('/api/oauth/matomo/callback', env().ADPORT_CLOUD_BASE_URL);
  url.searchParams.set('instance', createHash('sha256').update(hostedMatomoUrl(instance)).digest('base64url'));
  return url.href;
}

export function matomoOAuth(app?: MatomoApplication): OAuthAdapter<'matomo'> {
  return {
    provider: 'matomo', flowLabel: 'Matomo OAuth 2.0', pkce: true, codeParam: 'code', scopes: [scope],
    manualRevocationUrl: 'https://matomo.org/faq/how-to/set-up-oauth-2-0-authentication-for-the-matomo-api/', configured: () => true,
    authorizationUrl({ state, challenge }) {
      if (!app) throw new Error('Select the Matomo instance before connecting.');
      const url = endpoint(app, 'authorize');
      for (const [key, value] of Object.entries({ client_id: app.clientId, redirect_uri: matomoRedirectUri(app.url), response_type: 'code',
        scope, state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
      return url.href;
    },
    async exchange({ code, verifier }) {
      if (!app) throw new Error('The Matomo registration is missing.');
      const tokens = await matomoTokens(app, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: matomoRedirectUri(app.url) });
      // Some proxies strip the bearer header and Matomo can return an empty 200 response.
      const sites = await createHostedMatomoProvider({ url: app.url, accessToken: async () => tokens.accessToken }).listAccounts();
      if (!sites.length) throw new Error('Matomo did not return any visible sites. Check site access and bearer-header forwarding.');
      return { ...app, ...tokens, grantId: randomUUID() };
    },
    // Pausing a Matomo client affects every grant using that registration. Disconnect removes only this project's grant.
    async revoke() { return false; },
  };
}

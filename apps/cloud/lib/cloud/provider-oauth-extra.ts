import 'server-only';
import { buildSnapchatAuthUrl, exchangeSnapchatCode, SNAPCHAT_SCOPE } from '@adport/provider-snapchat';
import { buildSpotifyAuthUrl, exchangeSpotifyCode } from '@adport/provider-spotify';
import { buildPinterestAuthUrl, exchangePinterestCode } from '@adport/provider-pinterest';
import { buildLinkedInAuthUrl, exchangeLinkedInCode } from '@adport/provider-linkedin';
import { env } from '@/lib/env';
import type { OAuthAdapter } from './provider-oauth';

type Provider = 'snapchat' | 'spotify' | 'pinterest' | 'linkedin';
const prefixes = { snapchat: 'SNAPCHAT', spotify: 'SPOTIFY', pinterest: 'PINTEREST', linkedin: 'LINKEDIN' } as const;

export function cloudProviderApp(provider: Provider): { clientId: string; clientSecret: string } {
  const value = env(), prefix = prefixes[provider];
  const clientId = value[`${prefix}_CLIENT_ID`], clientSecret = value[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`${provider} application credentials are not configured.`);
  return { clientId, clientSecret };
}

function configured(provider: Provider): boolean {
  const value = env(), prefix = prefixes[provider];
  return value[`${prefix}_OAUTH_ENABLED`] === 'true' && Boolean(value[`${prefix}_CLIENT_ID`] && value[`${prefix}_CLIENT_SECRET`]);
}

function appForConsent(provider: Provider) {
  if (!configured(provider)) throw new Error(`${provider} cloud OAuth is not enabled for this deployment.`);
  return { ...cloudProviderApp(provider), redirectUri: new URL(`/api/oauth/${provider}/callback`, env().ADPORT_CLOUD_BASE_URL).toString() };
}

// Reuse the provider packages' schema-checked wire exchanges; no second token
// implementation in the cloud. OAuth state is consumed by the shared callback.
export const extraOAuthAdapters = {
  snapchat: {
    provider: 'snapchat', flowLabel: 'Snapchat Marketing OAuth 2.0', scopes: [SNAPCHAT_SCOPE],
    pkce: false, codeParam: 'code', manualRevocationUrl: 'https://accounts.snapchat.com/',
    configured: () => configured('snapchat'),
    authorizationUrl({ state }) { const app = appForConsent('snapchat'); return buildSnapchatAuthUrl(app.clientId, app.redirectUri, state); },
    async exchange({ code }) { return { refreshToken: await exchangeSnapchatCode({ ...appForConsent('snapchat'), code }) }; },
    async revoke() { return false; },
  },
  spotify: {
    provider: 'spotify', flowLabel: 'Spotify Ads OAuth 2.0', scopes: [],
    pkce: false, codeParam: 'code', manualRevocationUrl: 'https://www.spotify.com/account/apps/',
    configured: () => configured('spotify'),
    authorizationUrl({ state }) { const app = appForConsent('spotify'); return buildSpotifyAuthUrl(app.clientId, app.redirectUri, state); },
    async exchange({ code }) { return { refreshToken: await exchangeSpotifyCode({ ...appForConsent('spotify'), code }) }; },
    async revoke() { return false; },
  },
  pinterest: {
    provider: 'pinterest', flowLabel: 'Pinterest Ads OAuth 2.0', scopes: ['ads:read', 'ads:write'],
    pkce: false, codeParam: 'code', manualRevocationUrl: 'https://www.pinterest.com/settings/security',
    configured: () => configured('pinterest'),
    authorizationUrl({ state }) { const app = appForConsent('pinterest'); return buildPinterestAuthUrl(app.clientId, app.redirectUri, state); },
    async exchange({ code }) { return { refreshToken: await exchangePinterestCode({ ...appForConsent('pinterest'), code }) }; },
    async revoke() { return false; },
  },
  linkedin: {
    provider: 'linkedin', flowLabel: 'LinkedIn Marketing OAuth 2.0', scopes: ['rw_ads', 'r_ads_reporting'],
    pkce: false, codeParam: 'code', manualRevocationUrl: 'https://www.linkedin.com/psettings/permitted-services',
    configured: () => configured('linkedin'),
    authorizationUrl({ state }) { const app = appForConsent('linkedin'); return buildLinkedInAuthUrl(app.clientId, app.redirectUri, state); },
    async exchange({ code }) { return exchangeLinkedInCode({ ...appForConsent('linkedin'), code }); },
    async revoke() { return false; },
  },
} satisfies { [P in Provider]: OAuthAdapter<P> };

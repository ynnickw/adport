import 'server-only';
import { requestXToken, exchangeXToken, buildXAuthorizationUrl, revokeXToken } from '@adport/provider-x';
import { env } from '@/lib/env';
import type { OAuthAdapter } from './provider-oauth';

function app() {
  const { X_CONSUMER_KEY: consumerKey, X_CONSUMER_SECRET: consumerSecret } = env();
  if (!consumerKey || !consumerSecret) throw new Error('X Ads application credentials are not configured.');
  return { consumerKey, consumerSecret };
}
function enabledApp() {
  if (env().X_OAUTH_ENABLED !== 'true') throw new Error('X Ads cloud OAuth is not enabled for this deployment.');
  return app();
}

export const xOAuthAdapter: OAuthAdapter<'x'> = {
  provider: 'x', flowLabel: 'X Ads OAuth 1.0a', scopes: [], pkce: false,
  codeParam: 'oauth_verifier', stateParam: 'oauth_token',
  manualRevocationUrl: 'https://x.com/settings/connected_apps',
  configured: () => Boolean(env().X_OAUTH_ENABLED === 'true' && env().X_CONSUMER_KEY && env().X_CONSUMER_SECRET),
  async prepare() {
    const callback = new URL('/api/oauth/x/callback', env().ADPORT_CLOUD_BASE_URL).toString();
    const temporary = await requestXToken(enabledApp(), callback);
    // Reuse the single-use transaction's hashed state and encrypted verifier
    // fields for X's request token and secret; neither secret goes to the browser.
    return { state: temporary.requestToken, verifier: temporary.requestTokenSecret, authorizationUrl: buildXAuthorizationUrl(temporary.requestToken) };
  },
  authorizationUrl({ state }) { enabledApp(); return buildXAuthorizationUrl(state); },
  async exchange({ code, verifier, state }) {
    if (!state) throw new Error('X Ads callback is missing its request token.');
    return exchangeXToken(enabledApp(), { requestToken: state, requestTokenSecret: verifier }, code);
  },
  async revoke(credential) { await revokeXToken({ ...app(), accessToken: credential.accessToken, accessTokenSecret: credential.accessTokenSecret }); return true; },
};

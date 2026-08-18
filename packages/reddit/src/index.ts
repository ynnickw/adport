import type { CredentialRepository, ProviderModule } from '@adport/core';
import { RedditAdsClient, type RedditCredentials } from './client.js';
import { RedditAdsProvider } from './provider.js';
import { redditTools } from './tools.js';

export { RedditAdsClient, REDDIT_API_BASE, REDDIT_API_VERSION, REDDIT_TOKEN_URL, type RedditCredentials, type RedditEnvelope } from './client.js';
export { RedditAdsProvider, REDDIT_MICROS, type RedditCampaign } from './provider.js';
export { redditTools } from './tools.js';

export async function resolveRedditCredentials(store: CredentialRepository): Promise<RedditCredentials | undefined> {
  const record = await store.get('reddit');
  const data = record?.data;
  if (data?.client_id && data.client_secret && data.refresh_token && data.user_agent) {
    const source = record?.source ?? 'byo';
    return {
      clientId: data.client_id,
      clientSecret: data.client_secret,
      refreshToken: data.refresh_token,
      userAgent: data.user_agent,
      onRefreshToken: async (refreshToken) => {
        await store.set({ provider: 'reddit', source, data: { ...data, refresh_token: refreshToken } });
      },
    };
  }
  if (process.env.REDDIT_ADS_CLIENT_ID && process.env.REDDIT_ADS_CLIENT_SECRET && process.env.REDDIT_ADS_REFRESH_TOKEN && process.env.REDDIT_ADS_USER_AGENT) {
    return {
      clientId: process.env.REDDIT_ADS_CLIENT_ID,
      clientSecret: process.env.REDDIT_ADS_CLIENT_SECRET,
      refreshToken: process.env.REDDIT_ADS_REFRESH_TOKEN,
      userAgent: process.env.REDDIT_ADS_USER_AGENT,
    };
  }
  return undefined;
}

export async function createRedditModule(store: CredentialRepository): Promise<ProviderModule | undefined> {
  const credentials = await resolveRedditCredentials(store);
  if (!credentials) return undefined;
  const provider = new RedditAdsProvider(new RedditAdsClient(credentials));
  return { provider, tools: redditTools(provider) };
}

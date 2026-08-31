import type { CredentialStore, ProviderModule } from '@adport/core';
import { SpotifyAdsClient, type SpotifyCredentials } from './client.js';
import { SpotifyAdsProvider } from './provider.js';
import { spotifyTools } from './tools.js';
export { SpotifyAdsClient, SPOTIFY_API_BASE, SPOTIFY_TOKEN_URL, buildSpotifyAuthUrl, exchangeSpotifyCode, type SpotifyCredentials } from './client.js';
export { SpotifyAdsProvider } from './provider.js';
export { spotifyTools } from './tools.js';
export { accountSchema, campaignSchema, draftSchema, adSetSchema, reportSchema } from './schemas.js';

export async function resolveSpotifyCredentials(store: CredentialStore): Promise<SpotifyCredentials | undefined> {
  const data = (await store.get('spotify'))?.data;
  if (data?.client_id && data.client_secret && data.refresh_token) return {
    clientId: data.client_id, clientSecret: data.client_secret, refreshToken: data.refresh_token,
    onRefreshToken: async refreshToken => {
      const latest = await store.get('spotify');
      if (latest) await store.set({ provider: 'spotify', source: latest.source, data: { ...latest.data, refresh_token: refreshToken } });
    },
  };
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET && process.env.SPOTIFY_REFRESH_TOKEN) return {
    clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET, refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
  };
  return undefined;
}

export async function createSpotifyModule(store: CredentialStore): Promise<ProviderModule | undefined> {
  const credentials = await resolveSpotifyCredentials(store);
  if (!credentials) return undefined;
  const provider = new SpotifyAdsProvider(new SpotifyAdsClient(credentials));
  return { provider, tools: spotifyTools(provider) };
}

import { createContext } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider, appleTools } from '@adport/provider-apple';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { MicrosoftAdsClient, MicrosoftAdsProvider, microsoftTools } from '@adport/provider-microsoft';
import { TikTokAdsProvider, TikTokClient, tiktokTools } from '@adport/provider-tiktok';
import { RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { SnapchatAdsClient, SnapchatAdsProvider, snapchatTools } from '@adport/provider-snapchat';
import { SpotifyAdsClient, SpotifyAdsProvider, spotifyTools } from '@adport/provider-spotify';
import { PinterestAdsClient, PinterestAdsProvider, pinterestTools } from '@adport/provider-pinterest';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { XAdsClient, XAdsProvider, xTools } from '@adport/provider-x';
import { describe, expect, it } from 'vitest';

describe('all-provider shared tool surface', () => {
  it('registers native read/create/update/delete tools once for both CLI and MCP adapters', async () => {
    const google = new GoogleAdsProvider(new GoogleAdsRestClient({
      developerToken: 'x', clientId: 'x', clientSecret: 'x', refreshToken: 'x',
    }));
    const meta = new MetaAdsProvider(new MetaGraphClient({ accessToken: 'x' }));
    const tiktok = new TikTokAdsProvider(new TikTokClient({ accessToken: 'x' }), { appId: 'x', secret: 'x' });
    const apple = new AppleAdsProvider(new AppleAdsClient({
      clientId: 'x', teamId: 'x', keyId: 'x', privateKeyPem: 'x',
    }));
    const microsoft = new MicrosoftAdsProvider(new MicrosoftAdsClient({
      developerToken: 'x', clientId: 'x', refreshToken: 'x',
    }));
    const reddit = new RedditAdsProvider(new RedditAdsClient({
      clientId: 'x', clientSecret: 'x', refreshToken: 'x', userAgent: 'desktop:adport:test (by /u/test)',
    }));
    const snapchat = new SnapchatAdsProvider(new SnapchatAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const spotify = new SpotifyAdsProvider(new SpotifyAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const pinterest = new PinterestAdsProvider(new PinterestAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const linkedin = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'x' }));
    const x = new XAdsProvider(new XAdsClient({ consumerKey: 'x', consumerSecret: 'x', accessToken: 'x', accessTokenSecret: 'x' }));

    const runtime = await createContext({
      providerModules: [
        { provider: google, tools: googleTools(google) },
        { provider: meta, tools: metaTools(meta) },
        { provider: tiktok, tools: tiktokTools(tiktok) },
        { provider: apple, tools: appleTools(apple) },
        { provider: microsoft, tools: microsoftTools(microsoft) },
        { provider: reddit, tools: redditTools(reddit) },
        { provider: snapchat, tools: snapchatTools(snapchat) },
        { provider: spotify, tools: spotifyTools(spotify) },
        { provider: pinterest, tools: pinterestTools(pinterest) },
        { provider: linkedin, tools: linkedinTools(linkedin) },
        { provider: x, tools: xTools(x) },
      ],
    });
    const names = runtime.registry.list().map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'google_gaql', 'google_api_create', 'google_api_update', 'google_api_remove',
      'meta_api_read', 'meta_api_create', 'meta_api_update', 'meta_api_delete',
      'tiktok_api_read', 'tiktok_api_create', 'tiktok_api_update', 'tiktok_api_delete',
      'apple_api_read', 'apple_api_create', 'apple_api_update', 'apple_api_delete',
      'microsoft_api_read', 'microsoft_api_create', 'microsoft_api_update', 'microsoft_api_delete',
      'reddit_api_read', 'reddit_api_create', 'reddit_api_update', 'reddit_api_delete',
      'snapchat_list_campaigns', 'snapchat_create_campaign', 'snapchat_set_campaign_status', 'snapchat_set_budget',
      'spotify_list_campaigns', 'spotify_get_ad_set', 'spotify_create_campaign_draft', 'spotify_set_campaign_status', 'spotify_set_budget', 'spotify_set_ad_set_delivery',
      'pinterest_list_campaigns', 'pinterest_create_campaign', 'pinterest_set_campaign_status', 'pinterest_set_budget',
      'linkedin_list_campaigns', 'linkedin_list_campaign_groups', 'linkedin_create_campaign', 'linkedin_set_campaign_status', 'linkedin_set_budget',
      'x_list_campaigns', 'x_list_funding_instruments', 'x_list_line_items', 'x_create_campaign', 'x_set_campaign_status', 'x_set_budget',
    ]));
    expect(new Set(names).size).toBe(names.length);
  });
});

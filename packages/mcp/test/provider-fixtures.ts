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

export function providerModules() {
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

  return [
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
  ];
}

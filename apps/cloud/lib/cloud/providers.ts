import type { CloudProvider } from './types';

export const PROVIDER_LABELS: Record<CloudProvider, string> = {
  google: 'Google Ads',
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  apple: 'Apple Ads',
  microsoft: 'Microsoft Advertising',
  reddit: 'Reddit Ads',
  snapchat: 'Snapchat Ads',
  spotify: 'Spotify Ads',
  pinterest: 'Pinterest Ads',
  linkedin: 'LinkedIn Ads',
  x: 'X Ads',
};

export function providerLabel(name: string): string {
  return (PROVIDER_LABELS as Record<string, string>)[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

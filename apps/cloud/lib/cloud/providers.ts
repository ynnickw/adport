import type { CloudProvider } from './types';

export type ProviderCategory = 'advertising' | 'analytics';
const ANALYTICS_PROVIDERS: readonly string[] = ['ga4', 'gsc', 'gtm'];

export function providerCategory(provider: string): ProviderCategory {
  return ANALYTICS_PROVIDERS.includes(provider) ? 'analytics' : 'advertising';
}

export function usesAdAccountSlot(provider: string): boolean {
  return providerCategory(provider) === 'advertising';
}

export function providerAccountsPath(provider: string): string {
  return `${usesAdAccountSlot(provider) ? '/dashboard/accounts' : '/dashboard/analytics'}?select_provider=${encodeURIComponent(provider)}`;
}

export function providerConnectionsPath(provider: string): string {
  return `${usesAdAccountSlot(provider) ? '/dashboard/connections' : '/dashboard/analytics'}#platform-${encodeURIComponent(provider)}`;
}

export const PROVIDER_LABELS: Record<CloudProvider, string> = {
  ga4: 'Google Analytics 4',
  gsc: 'Google Search Console',
  gtm: 'Google Tag Manager',
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

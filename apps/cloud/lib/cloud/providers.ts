import { isTrackingSource } from '@adport/core/tool-catalog';
import type { CloudProvider } from './types';

export type ProviderCategory = 'advertising' | 'analytics';

export function providerCategory(provider: string): ProviderCategory {
  return isTrackingSource(provider) ? 'analytics' : 'advertising';
}

export function usesAdAccountSlot(provider: string): boolean {
  return providerCategory(provider) === 'advertising';
}

export function providerResourceName(provider: string, count = 2): string {
  const noun = provider === 'ga4' ? ['property', 'properties'] : (provider === 'gsc' || provider === 'matomo') ? ['site', 'sites'] : provider === 'gtm' ? ['container', 'containers'] : ['account', 'accounts'];
  return noun[count === 1 ? 0 : 1]!;
}

export function providerAccountsPath(provider: string): string {
  return `${usesAdAccountSlot(provider) ? '/dashboard/accounts' : '/dashboard/analytics'}?select_provider=${encodeURIComponent(provider)}`;
}

export function providerConnectionsPath(provider: string): string {
  return `${usesAdAccountSlot(provider) ? '/dashboard/connections' : '/dashboard/analytics'}#platform-${encodeURIComponent(provider)}`;
}

export const PROVIDER_LABELS: Record<CloudProvider, string> = {
  openai: 'OpenAI Ads',
  gravity: 'Gravity',
  matomo: 'Matomo',
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

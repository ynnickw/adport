import 'server-only';
import { env } from '@/lib/env';
import type { CloudProvider } from './types';
import { isSyntheticReviewer } from './synthetic-reviewer';

const gatedProviders = new Set<CloudProvider>(['snapchat', 'spotify', 'pinterest', 'linkedin', 'x']);

/** A server-owned allowlist limits new-provider testing without changing membership. */
export function providerAllowedForOrganization(provider: CloudProvider, organizationId?: string): boolean {
  if (organizationId && isSyntheticReviewer(organizationId)) return false;
  if (provider === 'ga4' || provider === 'gsc') {
    const config = env();
    if ((provider === 'ga4' ? config.GA4_OAUTH_ENABLED : config.GSC_OAUTH_ENABLED) === 'true') return true;
    const allowed = config.ANALYTICS_TEST_ORGANIZATION_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
    return Boolean(organizationId && allowed.includes(organizationId));
  }
  if (provider === 'gtm') {
    const config = env();
    if (config.GTM_OAUTH_ENABLED === 'true') return true;
    const allowed = config.GTM_TEST_ORGANIZATION_IDS?.split(',').map(id => id.trim()).filter(Boolean) ?? [];
    return Boolean(organizationId && allowed.includes(organizationId));
  }
  if (!gatedProviders.has(provider)) return true;
  const configured = env().ADPORT_PROVIDER_TEST_ORGANIZATION_IDS;
  if (configured === undefined) return true;
  const allowed = configured.split(',').map(id => id.trim()).filter(Boolean);
  return Boolean(organizationId && allowed.includes(organizationId));
}

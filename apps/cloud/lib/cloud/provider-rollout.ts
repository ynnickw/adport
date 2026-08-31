import 'server-only';
import { env } from '@/lib/env';
import type { CloudProvider } from './types';

const gatedProviders = new Set<CloudProvider>(['snapchat', 'spotify', 'pinterest', 'linkedin', 'x']);

/** A server-owned allowlist limits new-provider testing without changing membership. */
export function providerAllowedForOrganization(provider: CloudProvider, organizationId?: string): boolean {
  if (!gatedProviders.has(provider)) return true;
  const configured = env().ADPORT_PROVIDER_TEST_ORGANIZATION_IDS;
  if (configured === undefined) return true;
  const allowed = configured.split(',').map(id => id.trim()).filter(Boolean);
  return Boolean(organizationId && allowed.includes(organizationId));
}

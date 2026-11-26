import 'server-only';
import { GOOGLE_DATA_MANAGER_SCOPE } from '@/lib/cloud/google-oauth';
import { oauthAvailability, REDDIT_CONVERSIONS_SCOPE } from '@/lib/cloud/provider-oauth';
import { CLOUD_PROVIDERS } from '@/lib/cloud/types';
import { providerCategory, type ProviderCategory } from '@/lib/cloud/providers';
import type { ConnectionSummary } from '@/lib/cloud/repository';
import { PINTEREST_PIN_SCOPES, PINTEREST_SECRET_PIN_SCOPES, PINTEREST_CATALOG_SCOPES } from '@adport/provider-pinterest';
import type { ConnectionView, OAuthProviderView } from './provider-connections';

export function platformOptions(projectId: string, category: ProviderCategory): OAuthProviderView[] {
  const availability = oauthAvailability(projectId);
  return CLOUD_PROVIDERS.filter(id => providerCategory(id) === category)
    .map(id => ({ id, available: id === 'openai' || availability[id] }));
}

export function connectionView(connection: ConnectionSummary): ConnectionView {
  const { provider, status, accountSelectionId, accountSelectionUnavailable, externalLabel, lastError, scopes } = connection;
  return { provider, status, accountSelectionId, accountSelectionUnavailable, externalLabel, lastError,
    connectedAt: connection.connectedAt.toISOString(), lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
    dataManagerEnabled: provider === 'google' && scopes.includes(GOOGLE_DATA_MANAGER_SCOPE),
    redditConversionsEnabled: provider === 'reddit' && scopes.includes(REDDIT_CONVERSIONS_SCOPE),
    pinManagementEnabled: provider === 'pinterest' && PINTEREST_PIN_SCOPES.every(scope => scopes.includes(scope)),
    secretPinsEnabled: provider === 'pinterest' && PINTEREST_SECRET_PIN_SCOPES.every(scope => scopes.includes(scope)),
    catalogManagementEnabled: provider === 'pinterest' && PINTEREST_CATALOG_SCOPES.every(scope => scopes.includes(scope)),
  };
}

import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthAdapter, revokeGrant } from '@/lib/cloud/provider-oauth';
import {
  loadProviderCredential,
  recordAudit,
  removeProviderConnection,
} from '@/lib/cloud/repository';
import { isCloudProvider, isOAuthProvider } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';

/**
 * Disconnect a provider. OAuth grants are revoked at the provider first; when
 * the provider confirms revocation the encrypted credential is deleted. When
 * revocation fails transiently the credential is kept so the tenant can retry.
 */
export async function DELETE(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  try {
    const { provider } = await params;
    if (!isCloudProvider(provider)) return apiError(new Error('Unknown provider.'), 404);
    const organizationId = z.string().uuid().parse(new URL(request.url).searchParams.get('organization_id'));
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const stored = await loadProviderCredential(principal.organizationId, provider);
    if (!stored) return noStoreJson({ disconnected: false });

    let revokedAtProvider = false;
    if (isOAuthProvider(provider)) {
      if (oauthAdapter(provider).configured()) {
        // Throws on transient failure and keeps the encrypted credential for a retry.
        revokedAtProvider = await revokeGrant(provider, stored);
      }
    }
    const removed = await removeProviderConnection(principal.organizationId, provider, stored.connectionId);
    if (!removed) throw new Error('The connection changed while it was being disconnected. Please retry.');
    await recordAudit(principal, {
      event: 'revoked', provider, tool: isOAuthProvider(provider) ? 'oauth_disconnect' : 'credential_disconnect', accountId: '*',
      summary: revokedAtProvider
        ? `Revoked and removed ${provider} connection`
        : `Removed encrypted ${provider} credentials; provider-side revocation remains required`,
    });
    return noStoreJson({ disconnected: true, providerRevocationRequired: !revokedAtProvider });
  } catch (error) {
    return apiError(error, 403);
  }
}

import { sessionPrincipal } from '@/lib/cloud/auth';
import { revokeGoogleToken } from '@/lib/cloud/google-oauth';
import { loadGoogleCredential, recordAudit, removeGoogleConnection } from '@/lib/cloud/repository';
import { apiError, noStoreJson } from '@/lib/http';

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const principal = await sessionPrincipal(url.searchParams.get('organization_id') ?? undefined);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const stored = await loadGoogleCredential(principal.organizationId);
    if (!stored) return noStoreJson({ disconnected: false });
    // Keep the encrypted credential if Google is unavailable so revocation can be retried.
    await revokeGoogleToken(stored.refreshToken);
    const removed = await removeGoogleConnection(principal.organizationId, stored.connectionId);
    if (!removed) throw new Error('The Google connection changed while it was being disconnected. Please retry.');
    await recordAudit(principal, {
      event: 'revoked', provider: 'google', tool: 'oauth_disconnect', accountId: '*', summary: 'Revoked and removed Google Ads connection',
    });
    return noStoreJson({ disconnected: true });
  } catch (error) {
    return apiError(error, 403);
  }
}

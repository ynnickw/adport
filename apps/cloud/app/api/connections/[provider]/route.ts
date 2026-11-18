import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { OpenAIAdsClient, OpenAIAdsProvider } from '@adport/provider-openai';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthAdapter, revokeGrant } from '@/lib/cloud/provider-oauth';
import {
  loadProviderCredential,
  recordAudit,
  removeProviderConnection,
  upsertProviderConnection,
  setConnectionVerification,
} from '@/lib/cloud/repository';
import { stageAccountSelection } from '@/lib/cloud/account-selection';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { isCloudProvider, isOAuthProvider } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';

const keyConnection = z.object({ organization_id: z.string().uuid(), api_key: z.string().trim().min(1).max(4096) }).strict();

/** Advertiser keys are verified before replacing a grant, then use normal account selection. */
export async function POST(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  const { provider } = await params;
  if (provider !== 'openai') return noStoreJson({ error: 'This platform connects through OAuth.' }, 405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return noStoreJson({ error: 'Same-origin request required.' }, 403);
  const raw = await request.text();
  if (raw.length > 8192) return noStoreJson({ error: 'Connection request is too large.' }, 413);
  let input: z.infer<typeof keyConnection>;
  try { input = keyConnection.parse(JSON.parse(raw)); }
  catch { return noStoreJson({ error: 'Supply a project and an Advertiser API key.' }, 400); }
  try {
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '')) return noStoreJson({ error: 'Owner or admin access is required.' }, 403);
    if (!providerAllowedForOrganization('openai', principal.organizationId)) return noStoreJson({ error: 'This platform is unavailable for this project.' }, 403);
    const credential = { apiKey: input.api_key };
    const accounts = await new OpenAIAdsProvider(new OpenAIAdsClient(credential)).listAccounts();
    const selectionId = randomUUID();
    const connectionId = await upsertProviderConnection({ organizationId: principal.organizationId, userId: principal.userId!, provider: 'openai', credential,
      scopes: [], externalLabel: 'Choose accounts to finish connecting', selectionId });
    await stageAccountSelection({ principal, id: selectionId, connectionId, provider: 'openai', accounts, returnPath: '/dashboard/connections' });
    await setConnectionVerification(principal.organizationId, 'openai', { ok: true, label: 'Choose accounts to finish connecting' }, selectionId);
    await recordAudit(principal, { event: 'connected', provider: 'openai', tool: 'credential_connect', accountId: '*', summary: 'Verified OpenAI Ads Advertiser API key; account selection required' });
    return noStoreJson({ redirect: `/account-selection?selection_id=${selectionId}` });
  } catch {
    // Neither user-facing responses nor logs may contain the submitted key or upstream bodies.
    return noStoreJson({ error: 'OpenAI Ads connection failed. Verify the Advertiser API key and your project access, then retry.' }, 502);
  }
}

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
      const sharedGoogleGrant = provider === 'google' && (await Promise.all(['gtm', 'ga4', 'gsc'].map(id => loadProviderCredential(principal.organizationId, id as 'gtm' | 'ga4' | 'gsc')))).some(Boolean);
      if (oauthAdapter(provider).configured() && !sharedGoogleGrant) {
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

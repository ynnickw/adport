import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { OpenAIAdsClient, OpenAIAdsProvider } from '@adport/provider-openai';
import { GravityClient, GravityProvider } from '@adport/provider-gravity';
import { matomoBaseUrl } from '@adport/provider-matomo';
import { createHostedMatomoProvider } from '@/lib/cloud/matomo';
import { providerLabel } from '@/lib/cloud/providers';
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
import { isCloudProvider, isOAuthProvider, type CredentialProvider } from '@/lib/cloud/types';
import { env } from '@/lib/env';
import { HttpError, apiError, noStoreJson } from '@/lib/http';

const project = z.object({ organization_id: z.string().uuid(), return_to: z.string().max(2048).optional() });
const token = z.string().trim().min(1).max(4096);
const advertiserConnection = project.extend({ api_key: token }).strict();
const matomoConnection = project.extend({ url: matomoBaseUrl, token_auth: token }).strict();

function parseConnection(provider: CredentialProvider, value: unknown) {
  if (provider === 'matomo') {
    const { url, token_auth, ...project } = matomoConnection.parse(value);
    const credential = { url, tokenAuth: token_auth };
    return { ...project, provider, credential, listAccounts: () => createHostedMatomoProvider(credential).listAccounts() };
  }
  const { api_key, ...project } = advertiserConnection.parse(value);
  const credential = { apiKey: api_key };
  const advertisers = {
    openai: () => new OpenAIAdsProvider(new OpenAIAdsClient(credential)),
    gravity: () => new GravityProvider(new GravityClient(credential)),
  };
  return { ...project, provider, credential, listAccounts: () => advertisers[provider]().listAccounts() };
}

/** Verify provider tokens before storing them, then use the shared project account selection. */
export async function POST(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  const { provider } = await params;
  if (!isCloudProvider(provider) || isOAuthProvider(provider)) return noStoreJson({ error: 'This platform connects through OAuth.' }, 405);
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin && origin !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) {
    return noStoreJson({ error: 'Same-origin request required.' }, 403);
  }
  const raw = await request.text();
  if (raw.length > 8192) return noStoreJson({ error: 'Connection request is too large.' }, 413);
  let input: ReturnType<typeof parseConnection>;
  try { input = parseConnection(provider, JSON.parse(raw)); }
  catch { return noStoreJson({ error: provider === 'matomo' ? 'Supply a project, an HTTPS Matomo URL and an auth token.' : 'Supply a project and an Advertiser API key.' }, 400); }
  try {
    const principal = await sessionPrincipal(input.organization_id);
    if (!['owner', 'admin'].includes(principal.role ?? '')) return noStoreJson({ error: 'Owner or admin access is required.' }, 403);
    if (!providerAllowedForOrganization(provider, principal.organizationId)) return noStoreJson({ error: 'This platform is unavailable for this project.' }, 403);
    const accounts = await input.listAccounts();
    if (provider === 'matomo' && !accounts.length) return noStoreJson({ error: 'This token has view access to no Matomo sites.' }, 422);
    const selectionId = randomUUID();
    const label = provider === 'matomo' ? 'Choose sites to finish connecting' : 'Choose accounts to finish connecting';
    const connectionId = await upsertProviderConnection({ provider, credential: input.credential, organizationId: principal.organizationId, userId: principal.userId!,
      scopes: [], externalLabel: label, selectionId });
    await stageAccountSelection({ principal, id: selectionId, connectionId, provider, accounts,
      returnPath: input.return_to ?? (provider === 'matomo' ? '/dashboard/analytics' : '/dashboard/connections') });
    await setConnectionVerification(principal.organizationId, provider, { ok: true, label }, selectionId);
    await recordAudit(principal, { event: 'connected', provider, tool: 'credential_connect', accountId: '*', summary: `Verified ${providerLabel(provider)} credentials; account selection required` });
    return noStoreJson({ redirect: `/account-selection?selection_id=${selectionId}` });
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return noStoreJson({ error: error.message }, error.status);
    return noStoreJson({ error: provider === 'matomo' ? 'Matomo connection failed. Check the public HTTPS instance URL and the token’s site view access.' : `${providerLabel(provider)} connection failed. Verify the Advertiser API key and your project access, then retry.` }, 502);
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

import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { oauthAdapter, revokeGrant } from '@/lib/cloud/provider-oauth';
import {
  loadProviderCredential,
  recordAudit,
  removeProviderConnection,
  setConnectionVerification,
  upsertProviderConnection,
} from '@/lib/cloud/repository';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { isCloudProvider, isOAuthProvider, type KeyProvider, type ProviderCredentialMap } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';

/**
 * Only providers without a third-party OAuth grant accept tenant-supplied
 * credentials. Everything else is connected through /api/oauth/[provider].
 */
const keyProviderSchema = z.enum(['apple']);
const keySchemas = {
  apple: z.object({
    clientId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    keyId: z.string().min(1).max(255),
    privateKeyPem: z.string().regex(/^-----BEGIN (?:EC )?PRIVATE KEY-----/).max(16_384),
  }),
} satisfies { [P in KeyProvider]: z.ZodType<ProviderCredentialMap[P]> };

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Provider verification failed.';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

export async function POST(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  try {
    const route = await params;
    if (isOAuthProvider(route.provider)) {
      return apiError(new Error(`${route.provider} connects through the hosted OAuth flow; credentials are not accepted.`), 405);
    }
    const provider = keyProviderSchema.parse(route.provider);
    const input = await request.json() as { organizationId?: string };
    const organizationId = z.string().uuid().parse(input.organizationId);
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const credential = keySchemas[provider].parse(input) as ProviderCredentialMap[typeof provider];
    await upsertProviderConnection({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      provider,
      credential,
      externalLabel: `${provider} credentials pending verification`,
    });

    try {
      const runtime = await createTenantRuntime(principal);
      const accounts = await runtime.ctx.providers.get(provider).listAccounts();
      await setConnectionVerification(principal.organizationId, provider, {
        ok: true,
        label: `${accounts.length} accessible ${provider} account(s)`,
        subject: accounts.map((account) => account.id).join(','),
      });
      await recordAudit(principal, {
        event: 'connected', provider, tool: 'credential_connect', accountId: '*',
        summary: `Connected and verified ${provider} credentials`,
        details: { accessibleAccountCount: accounts.length },
      });
      return noStoreJson({ connected: true, accessibleAccountCount: accounts.length }, 201);
    } catch (error) {
      const providerError = safeProviderError(error);
      await setConnectionVerification(principal.organizationId, provider, { ok: false, error: providerError });
      await recordAudit(principal, {
        event: 'note', provider, tool: 'credential_verification', accountId: '*',
        summary: `Saved ${provider} credentials but verification failed`,
      });
      return noStoreJson({ connected: false, error: 'Credentials were encrypted, but provider verification failed.' }, 422);
    }
  } catch (error) {
    return apiError(error, 400);
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

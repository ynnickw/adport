import { z } from 'zod';
import { sessionPrincipal } from '@/lib/cloud/auth';
import {
  loadProviderCredential,
  recordAudit,
  removeProviderConnection,
  setConnectionVerification,
  upsertProviderConnection,
} from '@/lib/cloud/repository';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import type { CloudProvider, ProviderCredentialMap } from '@/lib/cloud/types';
import { apiError, noStoreJson } from '@/lib/http';

const providerSchema = z.enum(['meta', 'tiktok', 'apple', 'microsoft', 'reddit']);
const schemas = {
  meta: z.object({
    accessToken: z.string().min(20).max(4096),
    appId: z.string().min(1).max(255).optional(),
    appSecret: z.string().min(1).max(4096).optional(),
  }),
  tiktok: z.object({
    accessToken: z.string().min(20).max(4096),
    appId: z.string().min(1).max(255),
    secret: z.string().min(8).max(4096),
    sandbox: z.boolean().optional(),
  }),
  apple: z.object({
    clientId: z.string().min(1).max(255),
    teamId: z.string().min(1).max(255),
    keyId: z.string().min(1).max(255),
    privateKeyPem: z.string().regex(/^-----BEGIN (?:EC )?PRIVATE KEY-----/).max(16_384),
  }),
  microsoft: z.object({
    developerToken: z.string().min(8).max(4096),
    clientId: z.string().min(8).max(255),
    refreshToken: z.string().min(20).max(8192),
    clientSecret: z.string().min(1).max(4096).optional(),
    sandbox: z.boolean().optional(),
  }),
  reddit: z.object({
    clientId: z.string().min(1).max(255),
    clientSecret: z.string().min(8).max(4096),
    refreshToken: z.string().min(20).max(8192),
    userAgent: z.string().min(5).max(512),
  }),
} satisfies { [P in Exclude<CloudProvider, 'google'>]: z.ZodType<ProviderCredentialMap[P]> };

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Provider verification failed.';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

export async function POST(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  let organizationId: string | undefined;
  let provider: Exclude<CloudProvider, 'google'> | undefined;
  try {
    const route = await params;
    provider = providerSchema.parse(route.provider);
    const input = await request.json() as { organizationId?: string };
    organizationId = z.string().uuid().parse(input.organizationId);
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const credential = schemas[provider].parse(input) as ProviderCredentialMap[typeof provider];
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

export async function DELETE(request: Request, { params }: RouteContext<'/api/connections/[provider]'>) {
  try {
    const provider = providerSchema.parse((await params).provider);
    const organizationId = z.string().uuid().parse(new URL(request.url).searchParams.get('organization_id'));
    const principal = await sessionPrincipal(organizationId);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const stored = await loadProviderCredential(principal.organizationId, provider);
    if (!stored) return noStoreJson({ disconnected: false });
    const removed = await removeProviderConnection(principal.organizationId, provider, stored.connectionId);
    if (!removed) throw new Error('The connection changed while it was being removed. Please retry.');
    await recordAudit(principal, {
      event: 'revoked', provider, tool: 'credential_disconnect', accountId: '*',
      summary: `Removed encrypted ${provider} credentials; provider-side revocation remains required`,
    });
    return noStoreJson({ disconnected: true, providerRevocationRequired: true });
  } catch (error) {
    return apiError(error, 403);
  }
}

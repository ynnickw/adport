import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createPkce } from '@/lib/cloud/google-oauth';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { providerAllowedForOrganization } from '@/lib/cloud/provider-rollout';
import { createOAuthTransaction } from '@/lib/cloud/repository';
import { isOAuthProvider } from '@/lib/cloud/types';
import { apiError } from '@/lib/http';
import { safeReturnPath } from '@/lib/return-path';
import { popupReturnPath, validPopupId } from '@/lib/oauth-popup';
import { env } from '@/lib/env';

/**
 * Begin the hosted OAuth flow for a provider. The state is single-use, hashed
 * at rest, bound to the signed-in user and organization, and expires in ten
 * minutes. The PKCE verifier is encrypted with the same tenant binding.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/oauth/[provider]/start'>) {
  const url = new URL(request.url);
  const popupId = url.searchParams.get('popup_id');
  function failure(error: unknown, status: number) {
    if (!validPopupId(popupId)) return apiError(error, status);
    const next = `/dashboard/connections?${new URLSearchParams({ error: 'Could not start authorization. Please retry from Connections.' })}`;
    return NextResponse.redirect(new URL(popupReturnPath(popupId, next), env().ADPORT_CLOUD_BASE_URL));
  }
  try {
    const { provider } = await params;
    if (!isOAuthProvider(provider)) return failure(new Error('Unknown OAuth provider.'), 404);
    const principal = await sessionPrincipal(url.searchParams.get('organization_id') ?? undefined);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    if (!providerAllowedForOrganization(provider, principal.organizationId)) return failure(new Error('This provider is not enabled for this organization.'), 403);
    const adapter = oauthAdapter(provider);
    if (!adapter.configured()) return failure(new Error(`The hosted ${provider} application is not available yet.`), 503);
    const prepared = await adapter.prepare?.();
    const state = prepared?.state ?? randomBytes(32).toString('base64url');
    const pkce = createPkce();
    const returnPath = url.searchParams.has('return_to')
      ? safeReturnPath(url.searchParams.get('return_to'))
      : `/dashboard/accounts?select_provider=${provider}`;
    await createOAuthTransaction({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      provider,
      state,
      verifier: prepared?.verifier ?? pkce.verifier,
      returnPath: validPopupId(popupId) ? popupReturnPath(popupId, returnPath) : returnPath,
    });
    return NextResponse.redirect(prepared?.authorizationUrl ?? adapter.authorizationUrl({ state, challenge: pkce.challenge }));
  } catch (error) {
    return failure(error, 401);
  }
}

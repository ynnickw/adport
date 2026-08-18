import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { createPkce } from '@/lib/cloud/google-oauth';
import { oauthAdapter } from '@/lib/cloud/provider-oauth';
import { createOAuthTransaction } from '@/lib/cloud/repository';
import { isOAuthProvider } from '@/lib/cloud/types';
import { apiError } from '@/lib/http';

/**
 * Begin the hosted OAuth flow for a provider. The state is single-use, hashed
 * at rest, bound to the signed-in user and organization, and expires in ten
 * minutes. The PKCE verifier is encrypted with the same tenant binding.
 */
export async function GET(request: Request, { params }: RouteContext<'/api/oauth/[provider]/start'>) {
  try {
    const { provider } = await params;
    if (!isOAuthProvider(provider)) return apiError(new Error('Unknown OAuth provider.'), 404);
    const url = new URL(request.url);
    const principal = await sessionPrincipal(url.searchParams.get('organization_id') ?? undefined);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const adapter = oauthAdapter(provider);
    if (!adapter.configured()) return apiError(new Error(`The hosted ${provider} application is not available yet.`), 503);
    const state = randomBytes(32).toString('base64url');
    const pkce = createPkce();
    await createOAuthTransaction({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      provider,
      state,
      verifier: pkce.verifier,
      returnPath: '/dashboard/connections',
    });
    return NextResponse.redirect(adapter.authorizationUrl({ state, challenge: pkce.challenge }));
  } catch (error) {
    return apiError(error, 401);
  }
}

import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { buildGoogleAuthorizationUrl, createPkce } from '@/lib/cloud/google-oauth';
import { createOAuthTransaction } from '@/lib/cloud/repository';
import { apiError } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const principal = await sessionPrincipal(url.searchParams.get('organization_id') ?? undefined);
    if (!['owner', 'admin'].includes(principal.role ?? '')) throw new Error('Owner or admin access is required.');
    const state = randomBytes(32).toString('base64url');
    const pkce = createPkce();
    await createOAuthTransaction({
      organizationId: principal.organizationId,
      userId: principal.userId!,
      state,
      verifier: pkce.verifier,
    });
    return NextResponse.redirect(buildGoogleAuthorizationUrl({ state, challenge: pkce.challenge }));
  } catch (error) {
    return apiError(error, 401);
  }
}

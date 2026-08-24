import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/auth';
import {
  createGoogleOAuthState,
  googleAuthorizationUrl,
  GOOGLE_OAUTH_COOKIE,
  GOOGLE_OAUTH_MAX_AGE_SECONDS,
  managedGoogleOAuthConfigured,
} from '@/lib/google-oauth';

export async function GET() {
  const tenant = await requireTenant();
  if (!managedGoogleOAuthConfigured()) {
    return NextResponse.redirect(new URL('/connections?provider=google&oauth=unavailable', process.env.ADPORT_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000'));
  }
  const state = createGoogleOAuthState(tenant.workspaceId, tenant.userId);
  const response = NextResponse.redirect(googleAuthorizationUrl(state));
  response.cookies.set(GOOGLE_OAUTH_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/oauth/google/callback',
    maxAge: GOOGLE_OAUTH_MAX_AGE_SECONDS,
  });
  return response;
}

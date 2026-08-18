import { NextResponse } from 'next/server';
import { requireTenant } from '@/lib/auth';
import {
  createMetaOAuthState,
  managedMetaOAuthConfigured,
  metaAuthorizationUrl,
  META_OAUTH_COOKIE,
  META_OAUTH_MAX_AGE_SECONDS,
} from '@/lib/meta-oauth';

export async function GET() {
  const tenant = await requireTenant();
  if (!managedMetaOAuthConfigured()) {
    return NextResponse.redirect(new URL('/connections?oauth=unavailable', process.env.ADPORT_CLOUD_BASE_URL ?? 'http://127.0.0.1:3000'));
  }
  const state = createMetaOAuthState(tenant.workspaceId, tenant.userId);
  const response = NextResponse.redirect(metaAuthorizationUrl(state));
  response.cookies.set(META_OAUTH_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/oauth/meta/callback',
    maxAge: META_OAUTH_MAX_AGE_SECONDS,
  });
  return response;
}

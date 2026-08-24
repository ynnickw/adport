import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '@/lib/auth';
import {
  exchangeGoogleCode,
  GOOGLE_OAUTH_COOKIE,
  verifyGoogleOAuthState,
} from '@/lib/google-oauth';
import { discoverAndAllowAccounts } from '@/lib/runtime';
import { getCloudStore } from '@/lib/store';

function connectionsUrl(request: NextRequest, result: string): URL {
  return new URL(`/connections?provider=google&oauth=${result}`, request.nextUrl.origin);
}

function clearStateCookie(response: NextResponse): NextResponse {
  response.cookies.set(GOOGLE_OAUTH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/oauth/google/callback',
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const tenant = await requireTenant();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');
  const jar = await cookies();
  const cookieState = jar.get(GOOGLE_OAUTH_COOKIE)?.value;

  if (error || !code || !state || !cookieState || state !== cookieState
    || !verifyGoogleOAuthState(state, tenant.workspaceId, tenant.userId)) {
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, error ? 'denied' : 'invalid')));
  }

  const credentials = getCloudStore().credentials(tenant.workspaceId);
  try {
    const token = await exchangeGoogleCode(code);
    await credentials.set({
      provider: 'google',
      source: 'broker',
      data: { refresh_token: token.refreshToken },
    });
    await discoverAndAllowAccounts(tenant.workspaceId, 'google');
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, 'connected')));
  } catch {
    await credentials.delete('google');
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, 'failed')));
  }
}

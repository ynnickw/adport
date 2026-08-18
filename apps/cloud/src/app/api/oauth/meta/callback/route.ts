import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '@/lib/auth';
import { discoverAndAllowAccounts } from '@/lib/runtime';
import { getCloudStore } from '@/lib/store';
import { exchangeMetaCode, META_OAUTH_COOKIE, verifyMetaOAuthState } from '@/lib/meta-oauth';

function connectionsUrl(request: NextRequest, result: string): URL {
  return new URL(`/connections?oauth=${result}`, request.nextUrl.origin);
}

function clearStateCookie(response: NextResponse): NextResponse {
  response.cookies.set(META_OAUTH_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/oauth/meta/callback',
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
  const cookieState = jar.get(META_OAUTH_COOKIE)?.value;

  if (error || !code || !state || !cookieState || state !== cookieState
    || !verifyMetaOAuthState(state, tenant.workspaceId, tenant.userId)) {
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, error ? 'denied' : 'invalid')));
  }

  try {
    const token = await exchangeMetaCode(code);
    await getCloudStore().credentials(tenant.workspaceId).set({
      provider: 'meta',
      source: 'broker',
      data: { access_token: token.accessToken, app_id: token.appId },
    });
    await discoverAndAllowAccounts(tenant.workspaceId, 'meta');
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, 'connected')));
  } catch {
    return clearStateCookie(NextResponse.redirect(connectionsUrl(request, 'failed')));
  }
}

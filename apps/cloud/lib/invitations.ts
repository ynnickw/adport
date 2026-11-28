export function pendingInvitationPath(token: string): string {
  return '/auth/invite?' + new URLSearchParams({ token });
}

export function pendingInvitationRedirectUrl(baseUrl: string, token: string): string {
  const callback = new URL('/auth/callback', baseUrl);
  callback.searchParams.set('return_to', pendingInvitationPath(token));
  return callback.toString();
}

export function invitationTokens(hash: string, pending = false): { access_token: string; refresh_token: string } | undefined {
  if (!hash) return undefined;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const type = params.get('type');
  if (params.get('error') || (type !== 'invite' && !(pending && type === 'magiclink'))) {
    throw new Error('This email link is invalid or expired. Sign in with a fresh email link to continue.');
  }
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) throw new Error('This invitation is incomplete. Ask your organization admin for a new invitation.');
  return { access_token: accessToken, refresh_token: refreshToken };
}

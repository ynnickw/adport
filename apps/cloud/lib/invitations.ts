export function invitationRedirectUrl(baseUrl: string, projectId: string): string {
  const callback = new URL('/auth/callback', baseUrl);
  callback.searchParams.set('return_to', `/auth/invite?project_id=${encodeURIComponent(projectId)}`);
  return callback.toString();
}

export function invitationTokens(hash: string): { access_token: string; refresh_token: string } | undefined {
  if (!hash) return undefined;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('error') || params.get('type') !== 'invite') throw new Error('This invitation is invalid or expired. Ask your organization admin for a new invitation.');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) throw new Error('This invitation is incomplete. Ask your organization admin for a new invitation.');
  return { access_token: accessToken, refresh_token: refreshToken };
}

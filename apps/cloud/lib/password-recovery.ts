export function passwordRecoveryTokens(hash: string): { access_token: string; refresh_token: string } | undefined {
  if (!hash) return undefined;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('error') || params.get('type') !== 'recovery') throw new Error('This reset link is invalid or expired. Request a new one.');
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) throw new Error('This reset link is incomplete. Request a new one.');
  return { access_token: accessToken, refresh_token: refreshToken };
}

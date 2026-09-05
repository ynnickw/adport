import {
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  getMcpOAuthClient,
} from '@/lib/cloud/mcp-oauth-repository';
import { oauthError, validateRedirectUri, validateResource } from '@/lib/mcp-oauth';

function tokenResponse(pair: Awaited<ReturnType<typeof exchangeMcpAuthorizationCode>>) {
  return Response.json({
    access_token: pair.accessToken,
    token_type: 'Bearer',
    expires_in: pair.expiresIn,
    refresh_token: pair.refreshToken,
    scope: pair.scopes.join(' '),
  }, { headers: { 'cache-control': 'no-store', pragma: 'no-cache' } });
}

function oauthDiagnostic(event: string, details: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ area: 'mcp_oauth', event, ...details }));
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError('invalid_request', 'Token requests must use form encoding.');
  }
  const clientId = String(form.get('client_id') ?? '');
  if (!clientId || !(await getMcpOAuthClient(clientId))) return oauthError('invalid_client', 'Unknown client_id.', 401);
  try {
    const resource = validateResource(String(form.get('resource') ?? ''));
    const grantType = String(form.get('grant_type') ?? '');
    if (grantType === 'authorization_code') {
      const code = String(form.get('code') ?? '');
      const codeVerifier = String(form.get('code_verifier') ?? '');
      const redirectUri = validateRedirectUri(String(form.get('redirect_uri') ?? ''));
      if (!code || !codeVerifier) throw new Error('code and code_verifier are required.');
      const pair = await exchangeMcpAuthorizationCode({ clientId, code, codeVerifier, redirectUri, resource });
      oauthDiagnostic('authorization_code_exchanged');
      return tokenResponse(pair);
    }
    if (grantType === 'refresh_token') {
      const refreshToken = String(form.get('refresh_token') ?? '');
      if (!refreshToken) throw new Error('refresh_token is required.');
      const pair = await exchangeMcpRefreshToken({
        clientId,
        refreshToken,
        scopes: form.has('scope') ? String(form.get('scope')) : undefined,
        resource,
      });
      oauthDiagnostic('refresh_exchanged', { reusedRotatedToken: pair.reusedRotatedToken === true });
      return tokenResponse(pair);
    }
    return oauthError('unsupported_grant_type', 'Supported grant types are authorization_code and refresh_token.');
  } catch (error) {
    oauthDiagnostic('token_exchange_rejected', {
      grantType: String(form.get('grant_type') ?? 'unknown'),
      reason: error instanceof Error ? error.message : 'The grant is invalid.',
    });
    return oauthError('invalid_grant', error instanceof Error ? error.message : 'The grant is invalid.');
  }
}

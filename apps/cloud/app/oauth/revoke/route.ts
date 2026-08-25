import { getMcpOAuthClient, revokeMcpOAuthToken } from '@/lib/cloud/mcp-oauth-repository';
import { oauthError } from '@/lib/mcp-oauth';

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError('invalid_request', 'Revocation requests must use form encoding.');
  }
  const clientId = String(form.get('client_id') ?? '');
  const token = String(form.get('token') ?? '');
  if (!clientId || !(await getMcpOAuthClient(clientId))) return oauthError('invalid_client', 'Unknown client_id.', 401);
  if (!token) return oauthError('invalid_request', 'token is required.');
  await revokeMcpOAuthToken(clientId, token);
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
}

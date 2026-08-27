import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { authenticateApiKey, enforceRateLimit, resolveMembership } from './repository';
import { authenticateMcpOAuthAccessToken } from './mcp-oauth-repository';
import { HttpError } from '@/lib/http';
import type { TenantPrincipal } from './types';
import { applyPlanToPrincipal } from './plans';

export async function sessionPrincipal(requestedOrganizationId?: string): Promise<TenantPrincipal> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Authentication required.');
  const membership = await resolveMembership(data.user.id, requestedOrganizationId);
  return applyPlanToPrincipal({
    organizationId: membership.organizationId,
    userId: data.user.id,
    role: membership.role,
    scopes: ['tools:read', 'tools:write', 'connections:manage', 'keys:manage'],
  });
}

export async function apiPrincipal(request: Request): Promise<TenantPrincipal> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new HttpError('Bearer access token or API key required.', 401);
  const token = authorization.slice(7).trim();
  const principal = token.startsWith('adp_')
    ? await authenticateApiKey(token)
    : await authenticateMcpOAuthAccessToken(token);
  if (!principal) throw new HttpError('Invalid or expired access token or API key.', 401);
  const entitledPrincipal = await applyPlanToPrincipal(principal);
  // Do not key limits with client-controlled forwarding headers. Edge-level IP
  // limits are separate; this durable limit follows the authenticated key.
  if (!(await enforceRateLimit(entitledPrincipal.apiKeyId ?? entitledPrincipal.oauthTokenId!))) {
    throw new HttpError('Rate limit exceeded.', 429);
  }
  return entitledPrincipal;
}

export function requireScope(principal: TenantPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new HttpError(`API key lacks required scope: ${scope}`, 403);
}

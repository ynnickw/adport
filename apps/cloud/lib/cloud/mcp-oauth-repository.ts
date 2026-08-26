import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { db } from '@/lib/db';
import { digestState } from '@/lib/crypto';
import {
  type AuthorizationRequest,
  type McpOAuthClient,
  type McpOAuthScope,
  parseScopes,
  pkceChallenge,
  signAccessToken,
  verifyAccessTokenSignature,
} from '@/lib/mcp-oauth';
import type { TenantPrincipal } from './types';

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

export interface McpOAuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scopes: McpOAuthScope[];
}

export interface McpOAuthGrantSummary {
  clientId: string;
  userId: string;
  clientName: string;
  clientUri: string | null;
  scopes: McpOAuthScope[];
  resource: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

/**
 * List active MCP OAuth grants as credential metadata. Raw access and refresh
 * tokens are deliberately never recoverable or returned to the dashboard.
 */
export async function listMcpOAuthGrants(organizationId: string): Promise<McpOAuthGrantSummary[]> {
  return db()<McpOAuthGrantSummary[]>`
    select distinct on (refresh.client_id, refresh.user_id, refresh.resource)
      refresh.client_id,
      refresh.user_id,
      client.client_name,
      client.client_uri,
      refresh.scopes,
      refresh.resource,
      refresh.created_at,
      refresh.expires_at,
      access.last_used_at
    from private.mcp_oauth_refresh_tokens refresh
    join private.mcp_oauth_clients client on client.client_id = refresh.client_id
    left join lateral (
      select token.last_used_at
      from private.mcp_oauth_access_tokens token
      where token.organization_id = refresh.organization_id
        and token.user_id = refresh.user_id
        and token.client_id = refresh.client_id
        and token.resource = refresh.resource
        and token.revoked_at is null
      order by token.created_at desc
      limit 1
    ) access on true
    where refresh.organization_id = ${organizationId}
      and refresh.consumed_at is null
      and refresh.revoked_at is null
      and refresh.expires_at > now()
    order by refresh.client_id, refresh.user_id, refresh.resource, refresh.created_at desc
  `;
}

export async function registerMcpOAuthClient(input: {
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
}): Promise<McpOAuthClient> {
  const clientId = `adp_client_${randomBytes(24).toString('base64url')}`;
  const rows = await db()<McpOAuthClient[]>`
    insert into private.mcp_oauth_clients
      (client_id, client_name, client_uri, logo_uri, redirect_uris, grant_types, response_types, token_endpoint_auth_method)
    values
      (${clientId}, ${input.clientName}, ${input.clientUri ?? null}, ${input.logoUri ?? null},
       ${input.redirectUris}, ${input.grantTypes}, ${input.responseTypes}, ${input.tokenEndpointAuthMethod})
    returning client_id, client_name, client_uri, logo_uri, redirect_uris, grant_types,
      response_types, token_endpoint_auth_method, created_at
  `;
  return rows[0]!;
}

export async function getMcpOAuthClient(clientId: string): Promise<McpOAuthClient | undefined> {
  const rows = await db()<McpOAuthClient[]>`
    select client_id, client_name, client_uri, logo_uri, redirect_uris, grant_types,
      response_types, token_endpoint_auth_method, created_at
    from private.mcp_oauth_clients
    where client_id = ${clientId}
    limit 1
  `;
  return rows[0];
}

export async function createMcpAuthorizationCode(
  principal: TenantPrincipal,
  request: AuthorizationRequest,
): Promise<string> {
  if (!principal.userId) throw new Error('A user session is required to authorize an MCP client.');
  const code = `adp_code_${randomBytes(32).toString('base64url')}`;
  await db()`
    insert into private.mcp_oauth_authorization_codes
      (code_hash, organization_id, user_id, client_id, redirect_uri, scopes, code_challenge, resource, expires_at)
    values
      (${digestState(code)}, ${principal.organizationId}, ${principal.userId}, ${request.clientId},
       ${request.redirectUri}, ${request.scopes}, ${request.codeChallenge}, ${request.resource}, now() + interval '10 minutes')
  `;
  return code;
}

async function issueTokenPair(
  sql: postgres.TransactionSql,
  input: { organizationId: string; userId: string; clientId: string; scopes: McpOAuthScope[]; resource: string },
): Promise<McpOAuthTokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const tokenId = randomUUID();
  const refreshToken = `adp_refresh_${randomBytes(40).toString('base64url')}`;
  await sql`
    insert into private.mcp_oauth_access_tokens
      (token_id, organization_id, user_id, client_id, scopes, resource, expires_at)
    values
      (${tokenId}, ${input.organizationId}, ${input.userId}, ${input.clientId}, ${input.scopes},
       ${input.resource}, to_timestamp(${now + ACCESS_TOKEN_SECONDS}))
  `;
  await sql`
    insert into private.mcp_oauth_refresh_tokens
      (token_hash, organization_id, user_id, client_id, scopes, resource, expires_at)
    values
      (${digestState(refreshToken)}, ${input.organizationId}, ${input.userId}, ${input.clientId},
       ${input.scopes}, ${input.resource}, to_timestamp(${now + REFRESH_TOKEN_SECONDS}))
  `;
  const accessToken = signAccessToken({
    sub: input.userId,
    aud: input.resource,
    exp: now + ACCESS_TOKEN_SECONDS,
    iat: now,
    jti: tokenId,
    client_id: input.clientId,
    organization_id: input.organizationId,
    scope: input.scopes.join(' '),
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_SECONDS, scopes: input.scopes };
}

export async function exchangeMcpAuthorizationCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
}): Promise<McpOAuthTokenPair> {
  return db().begin(async (sql) => {
    const rows = await sql<Array<{
      codeHash: string;
      organizationId: string;
      userId: string;
      clientId: string;
      redirectUri: string;
      scopes: McpOAuthScope[];
      codeChallenge: string;
      resource: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }>>`
      select code_hash, organization_id, user_id, client_id, redirect_uri, scopes,
        code_challenge, resource, expires_at, consumed_at
      from private.mcp_oauth_authorization_codes
      where code_hash = ${digestState(input.code)}
      for update
    `;
    const code = rows[0];
    if (!code || code.consumedAt || code.expiresAt.getTime() <= Date.now()) throw new Error('Authorization code is invalid, expired, or already used.');
    if (code.clientId !== input.clientId || code.redirectUri !== input.redirectUri || code.resource !== input.resource) {
      throw new Error('Authorization code was not issued for this client, redirect URI, and resource.');
    }
    if (pkceChallenge(input.codeVerifier) !== code.codeChallenge) throw new Error('PKCE verification failed.');
    await sql`
      update private.mcp_oauth_authorization_codes set consumed_at = now()
      where code_hash = ${code.codeHash} and consumed_at is null
    `;
    return issueTokenPair(sql, code);
  });
}

export async function exchangeMcpRefreshToken(input: {
  clientId: string;
  refreshToken: string;
  scopes?: string;
  resource: string;
}): Promise<McpOAuthTokenPair> {
  return db().begin(async (sql) => {
    const rows = await sql<Array<{
      tokenHash: string;
      organizationId: string;
      userId: string;
      clientId: string;
      scopes: McpOAuthScope[];
      resource: string;
      expiresAt: Date;
      consumedAt: Date | null;
      revokedAt: Date | null;
    }>>`
      select token_hash, organization_id, user_id, client_id, scopes, resource, expires_at, consumed_at, revoked_at
      from private.mcp_oauth_refresh_tokens
      where token_hash = ${digestState(input.refreshToken)}
      for update
    `;
    const refresh = rows[0];
    if (!refresh || refresh.consumedAt || refresh.revokedAt || refresh.expiresAt.getTime() <= Date.now()) {
      throw new Error('Refresh token is invalid, expired, revoked, or already rotated.');
    }
    if (refresh.clientId !== input.clientId || refresh.resource !== input.resource) {
      throw new Error('Refresh token was not issued for this client and resource.');
    }
    const scopes = input.scopes ? parseScopes(input.scopes, []) : refresh.scopes;
    if (scopes.some((scope) => !refresh.scopes.includes(scope))) throw new Error('Requested scope exceeds the original grant.');
    await sql`
      update private.mcp_oauth_refresh_tokens set consumed_at = now()
      where token_hash = ${refresh.tokenHash} and consumed_at is null
    `;
    return issueTokenPair(sql, { ...refresh, scopes });
  });
}

export async function authenticateMcpOAuthAccessToken(token: string): Promise<TenantPrincipal | undefined> {
  let claims;
  try {
    claims = verifyAccessTokenSignature(token);
  } catch {
    return undefined;
  }
  const rows = await db()<Array<{
    tokenId: string;
    organizationId: string;
    userId: string;
    clientId: string;
    scopes: string[];
    resource: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }>>`
    select token_id, organization_id, user_id, client_id, scopes, resource, expires_at, revoked_at
    from private.mcp_oauth_access_tokens
    where token_id = ${claims.jti}
    limit 1
  `;
  const found = rows[0];
  if (!found || found.revokedAt || found.expiresAt.getTime() <= Date.now()) return undefined;
  if (found.organizationId !== claims.organization_id || found.userId !== claims.sub
    || found.clientId !== claims.client_id || found.resource !== claims.aud
    || found.scopes.join(' ') !== claims.scope) return undefined;
  await db()`update private.mcp_oauth_access_tokens set last_used_at = now() where token_id = ${found.tokenId}`;
  return {
    organizationId: found.organizationId,
    userId: found.userId,
    oauthTokenId: found.tokenId,
    clientId: found.clientId,
    scopes: found.scopes,
  };
}

export async function revokeMcpOAuthToken(clientId: string, token: string): Promise<void> {
  try {
    const claims = verifyAccessTokenSignature(token);
    if (claims.client_id === clientId) {
      await db()`
        update private.mcp_oauth_access_tokens set revoked_at = coalesce(revoked_at, now())
        where token_id = ${claims.jti} and client_id = ${clientId}
      `;
      return;
    }
  } catch {
    // The value may be a refresh token; revocation is deliberately idempotent.
  }
  await db()`
    update private.mcp_oauth_refresh_tokens set revoked_at = coalesce(revoked_at, now())
    where token_hash = ${digestState(token)} and client_id = ${clientId}
  `;
}

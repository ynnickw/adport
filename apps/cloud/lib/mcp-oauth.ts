import 'server-only';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';

export const MCP_OAUTH_SCOPES = ['tools:read', 'tools:write'] as const;
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export interface McpOAuthClient {
  clientId: string;
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: 'none';
  createdAt: Date;
}

export const clientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  redirect_uris: z.array(z.string()).min(1).max(10),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']),
  token_endpoint_auth_method: z.literal('none').default('none'),
  scope: z.string().trim().optional(),
}).strict().superRefine((client, context) => {
  if (!client.grant_types.includes('authorization_code')) {
    context.addIssue({
      code: 'custom',
      path: ['grant_types'],
      message: 'grant_types must include authorization_code.',
    });
  }
  if (client.scope !== undefined) {
    try {
      parseScopes(client.scope, []);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message: error instanceof Error ? error.message : 'scope is invalid.',
      });
    }
  }
});

export interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state?: string;
  scopes: McpOAuthScope[];
  codeChallenge: string;
  resource: string;
}

function signingKey(): Buffer {
  const key = Buffer.from(env().ADPORT_MCP_OAUTH_SIGNING_KEY, 'base64');
  if (key.length !== 32) throw new Error('ADPORT_MCP_OAUTH_SIGNING_KEY must decode to exactly 32 bytes.');
  return key;
}

export function mcpResourceUrl(): string {
  return new URL('/mcp', env().ADPORT_CLOUD_BASE_URL).toString();
}

export function oauthIssuerUrl(): string {
  return new URL('/', env().ADPORT_CLOUD_BASE_URL).toString().replace(/\/$/, '');
}

export function protectedResourceMetadataUrl(): string {
  return new URL('/.well-known/oauth-protected-resource/mcp', env().ADPORT_CLOUD_BASE_URL).toString();
}

export function validateRedirectUri(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('redirect_uri must be an absolute URL.');
  }
  if (url.hash || url.username || url.password) throw new Error('redirect_uri must not contain credentials or a fragment.');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('redirect_uri must use HTTPS or HTTP on a loopback host.');
  }
  return url.toString();
}

export function validateRedirectUris(values: string[]): string[] {
  const normalized = values.map(validateRedirectUri);
  if (new Set(normalized).size !== normalized.length) throw new Error('redirect_uris must not contain duplicates.');
  return normalized;
}

export function parseScopes(value: string | null | undefined, fallback: readonly McpOAuthScope[] = MCP_OAUTH_SCOPES): McpOAuthScope[] {
  const requested = value?.trim() ? value.trim().split(/\s+/) : [...fallback];
  if (!requested.length || requested.some((scope) => !(MCP_OAUTH_SCOPES as readonly string[]).includes(scope))) {
    throw new Error('scope contains an unsupported value.');
  }
  return [...new Set(requested)] as McpOAuthScope[];
}

export function validateResource(value: string | null | undefined): string {
  if (!value) throw new Error('resource is required.');
  let actual: URL;
  let expected: URL;
  try {
    actual = new URL(value);
    expected = new URL(mcpResourceUrl());
  } catch {
    throw new Error('resource must be an absolute URL.');
  }
  if (actual.hash || actual.search || actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
    throw new Error(`resource must identify ${expected.toString()}.`);
  }
  return expected.toString();
}

export function validateAuthorizationRequest(params: URLSearchParams, client: McpOAuthClient): AuthorizationRequest {
  if (params.get('response_type') !== 'code') throw new Error('response_type must be code.');
  const clientId = params.get('client_id');
  if (!clientId || clientId !== client.clientId) throw new Error('client_id is invalid.');
  const redirectUri = validateRedirectUri(params.get('redirect_uri') ?? '');
  if (!client.redirectUris.includes(redirectUri)) throw new Error('redirect_uri is not registered for this client.');
  if (params.get('code_challenge_method') !== 'S256') throw new Error('code_challenge_method must be S256.');
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new Error('code_challenge must be a valid S256 challenge.');
  const state = params.get('state') || undefined;
  if (state && state.length > 2048) throw new Error('state is too long.');
  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    state,
    scopes: parseScopes(params.get('scope')),
    codeChallenge,
    resource: validateResource(params.get('resource')),
  };
}

export function pkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('code_verifier is invalid.');
  return createHash('sha256').update(verifier).digest('base64url');
}

interface AccessTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
  client_id: string;
  organization_id: string;
  scope: string;
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signAccessToken(claims: Omit<AccessTokenClaims, 'iss'>): string {
  const header = encodePart({ alg: 'HS256', typ: 'at+jwt', kid: 'adport-mcp-oauth-v1' });
  const payload = encodePart({ ...claims, iss: oauthIssuerUrl() });
  const signature = createHmac('sha256', signingKey()).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessTokenSignature(token: string): AccessTokenClaims {
  const [headerRaw, payloadRaw, signatureRaw, extra] = token.split('.');
  if (!headerRaw || !payloadRaw || !signatureRaw || extra) throw new Error('Malformed access token.');
  const expected = createHmac('sha256', signingKey()).update(`${headerRaw}.${payloadRaw}`).digest();
  const actual = Buffer.from(signatureRaw, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid access token signature.');
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerRaw, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadRaw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed access token.');
  }
  const headerSchema = z.object({ alg: z.literal('HS256'), typ: z.literal('at+jwt'), kid: z.literal('adport-mcp-oauth-v1') });
  headerSchema.parse(header);
  const claims = z.object({
    iss: z.literal(oauthIssuerUrl()),
    sub: z.string().uuid(),
    aud: z.literal(mcpResourceUrl()),
    exp: z.number().int(),
    iat: z.number().int(),
    jti: z.string().uuid(),
    client_id: z.string().min(1),
    organization_id: z.string().uuid(),
    scope: z.string(),
  }).parse(payload);
  if (claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('Access token expired.');
  parseScopes(claims.scope, []);
  return claims;
}

export function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache' },
  });
}

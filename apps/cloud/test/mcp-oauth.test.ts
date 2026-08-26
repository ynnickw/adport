import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  clientRegistrationSchema,
  mcpResourceUrl,
  oauthIssuerUrl,
  parseScopes,
  pkceChallenge,
  signAccessToken,
  validateAuthorizationRequest,
  validateRedirectUri,
  validateResource,
  verifyAccessTokenSignature,
  type McpOAuthClient,
} from '@/lib/mcp-oauth';
import { safeReturnPath } from '@/lib/return-path';

const client: McpOAuthClient = {
  clientId: 'adp_client_test',
  clientName: 'Test MCP client',
  redirectUris: ['http://127.0.0.1:45892/callback', 'https://client.example/callback'],
  grantTypes: ['authorization_code', 'refresh_token'],
  responseTypes: ['code'],
  tokenEndpointAuthMethod: 'none',
  createdAt: new Date(),
};

describe('MCP OAuth protocol helpers', () => {
  it('publishes one audience-bound MCP resource and issuer', () => {
    const expectedIssuer = new URL(process.env.ADPORT_CLOUD_BASE_URL!).origin;
    expect(oauthIssuerUrl()).toBe(expectedIssuer);
    expect(mcpResourceUrl()).toBe(`${expectedIssuer}/mcp`);
    expect(validateResource(`${expectedIssuer}/mcp`)).toBe(mcpResourceUrl());
    expect(() => validateResource(`${expectedIssuer}/api/v1/accounts`)).toThrow(/must identify/);
    expect(() => validateResource('https://other.example/mcp')).toThrow(/must identify/);
  });

  it('accepts HTTPS and loopback callbacks while rejecting unsafe redirects', () => {
    expect(validateRedirectUri('https://client.example/callback')).toBe('https://client.example/callback');
    expect(validateRedirectUri('http://localhost:3000/callback')).toBe('http://localhost:3000/callback');
    expect(validateRedirectUri('http://127.0.0.1:45892/callback')).toBe('http://127.0.0.1:45892/callback');
    expect(() => validateRedirectUri('http://client.example/callback')).toThrow(/HTTPS/);
    expect(() => validateRedirectUri('https://client.example/callback#token')).toThrow(/fragment/);
    expect(() => validateRedirectUri('https://user:pass@client.example/callback')).toThrow(/credentials/);
  });

  it('registers public authorization-code clients only', () => {
    expect(clientRegistrationSchema.parse({
      client_name: 'OAuth client',
      redirect_uris: ['https://client.example/callback'],
      scope: 'tools:read tools:write',
    })).toMatchObject({
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    expect(() => clientRegistrationSchema.parse({
      client_name: 'Refresh-only client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['refresh_token'],
    })).toThrow(/authorization_code/);
    expect(() => clientRegistrationSchema.parse({
      client_name: 'Unsupported scope client',
      redirect_uris: ['https://client.example/callback'],
      scope: 'admin',
    })).toThrow(/unsupported/);
  });

  it('accepts Claude client metadata without weakening validated OAuth fields', () => {
    const parsed = clientRegistrationSchema.parse({
      client_name: 'Claude',
      application_type: 'native',
      redirect_uris: ['http://127.0.0.1:45892/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      software_version: '1.0.0',
    });

    expect(parsed.application_type).toBe('native');
    expect(parsed).not.toHaveProperty('software_version');
    expect(() => clientRegistrationSchema.parse({
      client_name: 'Claude',
      application_type: 'desktop',
      redirect_uris: ['http://127.0.0.1:45892/callback'],
    })).toThrow(/application_type/);
  });

  it('requires an exact registered redirect, S256 PKCE, resource, and supported scopes', () => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      scope: 'tools:read tools:write',
      resource: mcpResourceUrl(),
      state: 'opaque-state',
    });
    expect(validateAuthorizationRequest(params, client)).toMatchObject({
      clientId: client.clientId,
      scopes: ['tools:read', 'tools:write'],
      state: 'opaque-state',
    });
    params.set('redirect_uri', 'https://evil.example/callback');
    expect(() => validateAuthorizationRequest(params, client)).toThrow(/not registered/);
    params.set('redirect_uri', client.redirectUris[0]!);
    params.set('scope', 'connections:manage');
    expect(() => validateAuthorizationRequest(params, client)).toThrow(/unsupported/);
  });

  it('implements the RFC 7636 S256 verifier vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('signs and verifies short-lived access tokens with issuer, audience, client, organization, and scopes', () => {
    const now = Math.floor(Date.now() / 1000);
    const input = {
      sub: randomUUID(),
      aud: mcpResourceUrl(),
      exp: now + 3600,
      iat: now,
      jti: randomUUID(),
      client_id: client.clientId,
      organization_id: randomUUID(),
      scope: 'tools:read',
    };
    const token = signAccessToken(input);
    expect(verifyAccessTokenSignature(token)).toMatchObject(input);
    const changed = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyAccessTokenSignature(changed)).toThrow(/signature/);
  });

  it('preserves only local post-login return paths', () => {
    expect(safeReturnPath('/oauth/authorize?client_id=abc')).toBe('/oauth/authorize?client_id=abc');
    expect(safeReturnPath('https://evil.example')).toBe('/dashboard');
    expect(safeReturnPath('//evil.example')).toBe('/dashboard');
    expect(safeReturnPath('/\\evil.example')).toBe('/dashboard');
  });

  it('deduplicates requested scopes without widening them', () => {
    expect(parseScopes('tools:read tools:read')).toEqual(['tools:read']);
    expect(parseScopes(undefined)).toEqual(['tools:read', 'tools:write']);
  });
});

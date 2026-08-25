import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey, resolveMembership } from '@/lib/cloud/repository';
import {
  createMcpAuthorizationCode,
  getMcpOAuthClient,
} from '@/lib/cloud/mcp-oauth-repository';
import { closeDbForTests, db } from '@/lib/db';
import {
  mcpResourceUrl,
  pkceChallenge,
  validateAuthorizationRequest,
} from '@/lib/mcp-oauth';

const baseUrl = process.env.ADPORT_HTTP_TEST_BASE_URL;
const describeHttp = baseUrl ? describe : describe.skip;

class TestOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = 'http://127.0.0.1:45893/callback';
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Adport SDK OAuth integration test',
    redirect_uris: [this.redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  authorizationUrl?: URL;
  private information?: OAuthClientInformationMixed;
  private grant?: OAuthTokens;
  private verifier?: string;

  clientInformation() { return this.information; }
  saveClientInformation(information: OAuthClientInformationMixed) { this.information = information; }
  tokens() { return this.grant; }
  saveTokens(tokens: OAuthTokens) { this.grant = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() {
    if (!this.verifier) throw new Error('Missing PKCE verifier');
    return this.verifier;
  }
}

describeHttp('running cloud server', () => {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  let userId: string;
  let organizationId: string;
  let apiKey: string;
  let apiKeyId: string;
  const oauthClientIds = new Set<string>();

  beforeAll(async () => {
    const email = `http-${randomUUID()}@example.test`;
    const created = await admin.auth.admin.createUser({
      email,
      password: 'Local-HTTP-Passw0rd!',
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('User creation failed');
    userId = created.data.user.id;
    organizationId = (await resolveMembership(userId)).organizationId;
    const createdKey = await createApiKey({
      organizationId,
      userId,
      name: 'HTTP integration',
      scopes: ['tools:read', 'tools:write'],
    });
    apiKey = createdKey.key;
    apiKeyId = createdKey.id;
  });

  afterAll(async () => {
    if (organizationId) await db()`delete from public.organizations where id = ${organizationId}`;
    for (const clientId of oauthClientIds) {
      await db()`delete from private.mcp_oauth_clients where client_id = ${clientId}`;
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
    await closeDbForTests();
  });

  it('distinguishes authentication failures from an authenticated onboarding state', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/v1/accounts`);
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${baseUrl}/api/v1/accounts`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(authenticated.status).toBe(409);
    expect(await authenticated.json()).toMatchObject({ error: expect.stringContaining('No ad providers') });
    const keyUsage = await db()<Array<{ lastUsedAt: Date | null }>>`
      select last_used_at from public.api_keys where id = ${apiKeyId}
    `;
    expect(keyUsage[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('completes a remote MCP initialization handshake over HTTP', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'adport-http-integration', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('adport-cloud');
  });

  it('discovers OAuth, dynamically registers a public client, exchanges PKCE code, and initializes MCP', async () => {
    const protectedResource = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: ['tools:read', 'tools:write'],
    });
    const metadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(await metadata.json()).toMatchObject({
      issuer: baseUrl,
      registration_endpoint: `${baseUrl}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    const challenge = await fetch(`${baseUrl}/mcp`, { method: 'POST' });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');

    const registration = await fetch(`${baseUrl}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Adport HTTP OAuth test',
        redirect_uris: ['http://127.0.0.1:45892/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    oauthClientIds.add(registered.client_id);

    const verifier = 'h'.repeat(64);
    const code = await createMcpAuthorizationCode({ organizationId, userId, scopes: [] }, {
      clientId: registered.client_id,
      clientName: 'Adport HTTP OAuth test',
      redirectUri: 'http://127.0.0.1:45892/callback',
      scopes: ['tools:read'],
      codeChallenge: pkceChallenge(verifier),
      resource: mcpResourceUrl(),
    });
    const token = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: registered.client_id,
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:45892/callback',
        resource: `${baseUrl}/mcp`,
      }),
    });
    expect(token.status).toBe(200);
    const grant = await token.json() as { access_token: string; refresh_token: string; scope: string };
    expect(grant.scope).toBe('tools:read');

    const initialized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${grant.access_token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'adport-oauth-http-integration', version: '1.0.0' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ result: { serverInfo: { name: 'adport-cloud' } } });
  });

  it('authenticates through the official MCP SDK transport and lists tools', async () => {
    const provider = new TestOAuthProvider();
    const firstTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: provider });
    const firstClient = new Client({ name: 'adport-sdk-oauth-test', version: '1.0.0' });
    await expect(firstClient.connect(firstTransport)).rejects.toBeInstanceOf(UnauthorizedError);

    const authorizationUrl = provider.authorizationUrl;
    const information = await provider.clientInformation();
    expect(authorizationUrl).toBeInstanceOf(URL);
    expect(information?.client_id).toMatch(/^adp_client_/);
    oauthClientIds.add(information!.client_id);
    const registered = await getMcpOAuthClient(information!.client_id);
    expect(registered).toBeDefined();
    const authorization = validateAuthorizationRequest(authorizationUrl!.searchParams, registered!);
    const code = await createMcpAuthorizationCode({ organizationId, userId, scopes: [] }, authorization);
    await firstTransport.finishAuth(code);

    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { authProvider: provider });
    const client = new Client({ name: 'adport-sdk-oauth-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
    expect(tools.tools.some((tool) => tool.name === 'accounts_list')).toBe(true);
    await client.close();
  });
});

describeHttp('hosted OAuth broker over HTTP', () => {
  it('serves the sign-in screen at the root and gates the dashboard', async () => {
    const root = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(root.status).toBe(200);
    const html = await root.text();
    expect(html).toContain('auth-card');
    expect(html).toContain('name="password"');
    const dashboard = await fetch(`${baseUrl}/dashboard/connections`, { redirect: 'manual' });
    expect([302, 307]).toContain(dashboard.status);
    expect(new URL(dashboard.headers.get('location')!, baseUrl).pathname).toBe('/');
  });

  it('requires a session before starting any provider OAuth flow and rejects credential posts for OAuth providers', async () => {
    for (const provider of ['google', 'meta', 'tiktok', 'microsoft', 'reddit']) {
      const start = await fetch(`${baseUrl}/api/oauth/${provider}/start`, { redirect: 'manual' });
      expect(start.status).toBe(401);
    }
    const unknown = await fetch(`${baseUrl}/api/oauth/nope/start`, { redirect: 'manual' });
    expect(unknown.status).toBe(404);
    const post = await fetch(`${baseUrl}/api/connections/meta`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'x'.repeat(30) }),
    });
    expect(post.status).toBe(405);
  });
});

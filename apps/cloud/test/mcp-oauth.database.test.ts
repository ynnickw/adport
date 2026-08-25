import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authenticateMcpOAuthAccessToken,
  createMcpAuthorizationCode,
  exchangeMcpAuthorizationCode,
  exchangeMcpRefreshToken,
  registerMcpOAuthClient,
  revokeMcpOAuthToken,
} from '@/lib/cloud/mcp-oauth-repository';
import { resolveMembership } from '@/lib/cloud/repository';
import { closeDbForTests, db } from '@/lib/db';
import { mcpResourceUrl, pkceChallenge, type AuthorizationRequest } from '@/lib/mcp-oauth';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;

describeDatabase('MCP OAuth persistence and token lifecycle', () => {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  let userId: string;
  let organizationId: string;
  let clientId: string;
  const verifier = 'v'.repeat(64);
  const redirectUri = 'http://127.0.0.1:45892/callback';

  beforeAll(async () => {
    const created = await admin.auth.admin.createUser({
      email: `mcp-oauth-${randomUUID()}@example.test`,
      password: 'Local-MCP-OAuth-Passw0rd!',
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error('User creation failed');
    userId = created.data.user.id;
    organizationId = (await resolveMembership(userId)).organizationId;
    const client = await registerMcpOAuthClient({
      clientName: 'Database OAuth test',
      redirectUris: [redirectUri],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
    });
    clientId = client.clientId;
  });

  afterAll(async () => {
    if (organizationId) await db()`delete from public.organizations where id = ${organizationId}`;
    if (clientId) await db()`delete from private.mcp_oauth_clients where client_id = ${clientId}`;
    if (userId) await admin.auth.admin.deleteUser(userId);
    await closeDbForTests();
  });

  it('enforces PKCE and one-time authorization codes, rotates refresh tokens, and revokes access tokens', async () => {
    const authorization: AuthorizationRequest = {
      clientId,
      clientName: 'Database OAuth test',
      redirectUri,
      scopes: ['tools:read', 'tools:write'],
      codeChallenge: pkceChallenge(verifier),
      resource: mcpResourceUrl(),
      state: 'test-state',
    };
    const code = await createMcpAuthorizationCode({ organizationId, userId, scopes: [] }, authorization);
    await expect(exchangeMcpAuthorizationCode({
      clientId, code, codeVerifier: 'x'.repeat(64), redirectUri, resource: mcpResourceUrl(),
    })).rejects.toThrow(/PKCE/);

    const first = await exchangeMcpAuthorizationCode({
      clientId, code, codeVerifier: verifier, redirectUri, resource: mcpResourceUrl(),
    });
    expect(first).toMatchObject({ expiresIn: 3600, scopes: ['tools:read', 'tools:write'] });
    await expect(authenticateMcpOAuthAccessToken(first.accessToken)).resolves.toMatchObject({
      organizationId,
      userId,
      clientId,
      scopes: ['tools:read', 'tools:write'],
    });
    await expect(exchangeMcpAuthorizationCode({
      clientId, code, codeVerifier: verifier, redirectUri, resource: mcpResourceUrl(),
    })).rejects.toThrow(/already used/);

    const second = await exchangeMcpRefreshToken({
      clientId,
      refreshToken: first.refreshToken,
      scopes: 'tools:read',
      resource: mcpResourceUrl(),
    });
    expect(second.scopes).toEqual(['tools:read']);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await expect(exchangeMcpRefreshToken({
      clientId, refreshToken: first.refreshToken, resource: mcpResourceUrl(),
    })).rejects.toThrow(/already rotated/);

    await revokeMcpOAuthToken(clientId, second.accessToken);
    await expect(authenticateMcpOAuthAccessToken(second.accessToken)).resolves.toBeUndefined();
  });
});

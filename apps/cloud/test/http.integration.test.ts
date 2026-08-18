import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiKey, resolveMembership } from '@/lib/cloud/repository';
import { closeDbForTests, db } from '@/lib/db';

const baseUrl = process.env.ADPORT_HTTP_TEST_BASE_URL;
const describeHttp = baseUrl ? describe : describe.skip;

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

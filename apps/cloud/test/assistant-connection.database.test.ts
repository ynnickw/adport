import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as mcp } from '@/app/mcp/route';
import { db, closeDbForTests } from '@/lib/db';
import { resetEnvForTests } from '@/lib/env';
import { createApiKey, upsertProviderConnection } from '@/lib/cloud/repository';
import { saveAccountSelection, stageAccountSelection } from '@/lib/cloud/account-selection';
import { getAssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import { getOnboardingState, updateOnboardingState } from '@/lib/cloud/onboarding';
import { registerMcpOAuthClient, createMcpAuthorizationCode, exchangeMcpAuthorizationCode, exchangeMcpRefreshToken, revokeMcpOAuthToken } from '@/lib/cloud/mcp-oauth-repository';
import { mcpResourceUrl, pkceChallenge } from '@/lib/mcp-oauth';
import type { TenantPrincipal } from '@/lib/cloud/types';

const suite = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
suite('verified onboarding through the real hosted MCP transport', () => {
  let admin: ReturnType<typeof postgres>;
  const users: string[] = [];
  const projects: string[] = [];
  const clients: string[] = [];
  let owner: TenantPrincipal;
  let other: TenantPrincipal;
  let key: Awaited<ReturnType<typeof createApiKey>>;
  async function call(token: string, method: string, params: unknown) {
    const response = await mcp(new Request(mcpResourceUrl(), { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return { status: response.status, body: await response.json() };
  }
  beforeAll(async () => {
    const url = new URL(process.env.SUPABASE_DB_URL!);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['55322', '56322', '58322'].includes(url.port)) throw new Error('Use an explicit local Adport test database.');
    process.env.GOOGLE_ADS_CLIENT_ID = 'local-fixture-client';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'local-fixture-secret';
    resetEnvForTests();
    admin = postgres(process.env.SUPABASE_DB_URL!, { max: 1 });
    for (let i = 0; i < 2; i++) {
      const userId = randomUUID(); users.push(userId);
      await admin`insert into auth.users (id, email, raw_user_meta_data) values (${userId}, ${`activation-${userId}@example.test`}, '{}'::jsonb)`;
      const [member] = await admin`select organization_id from public.organization_memberships where user_id = ${userId}`;
      const principal: TenantPrincipal = { organizationId: member!.organization_id, userId, role: 'owner', scopes: ['tools:read'] };
      projects.push(principal.organizationId);
      if (i === 0) owner = principal; else other = principal;
    }
    const selectionId = randomUUID();
    const connectionId = await upsertProviderConnection({ organizationId: owner.organizationId, userId: owner.userId!, provider: 'google', credential: { refreshToken: 'local-fixture-only' }, selectionId });
    await stageAccountSelection({ principal: owner, id: selectionId, connectionId, provider: 'google', accounts: [{ provider: 'google', id: '1234567890', name: 'Local test account', currency: 'EUR' }], returnPath: '/onboarding' });
    await saveAccountSelection(owner, selectionId, ['1234567890'], undefined, { maxActiveAccounts: 3, currentPlan: 'Free', recommendedPlan: 'operator' });
    key = await createApiKey({ organizationId: owner.organizationId, userId: owner.userId!, name: 'Local setup test', scopes: ['tools:read'] });
  });
  afterAll(async () => {
    if (!admin) return;
    for (const project of projects) await admin`delete from public.organizations where id = ${project}`;
    for (const client of clients) await admin`delete from private.mcp_oauth_clients where client_id = ${client}`;
    for (const user of users) await admin`delete from auth.users where id = ${user}`;
    await closeDbForTests(); await admin.end();
  });

  it('keeps skips separate from verified completion and rejects crafted completion', async () => {
    await updateOnboardingState(owner, { currentStep: 'agent', skip: true });
    expect(await getOnboardingState(owner.organizationId)).toMatchObject({ currentStep: 'agent', completedAt: null, skippedAt: expect.any(Date) });
    await expect(updateOnboardingState(owner, { currentStep: 'complete', complete: true })).rejects.toThrow(/run a read/);
    await expect(updateOnboardingState(owner, { currentStep: 'complete' })).rejects.toThrow(/Set up later/);
    expect(await getAssistantConnectionStatus(owner)).toMatchObject({ authorized: true, verified: false, hasAccounts: true });
  });

  it('does not verify authentication, discovery, or a failed read', async () => {
    expect((await call(key.key, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Fixture', version: '1' } })).status).toBe(200);
    expect((await call(key.key, 'tools/list', {})).status).toBe(200);
    const failure = await call(key.key, 'tools/call', { name: 'report', arguments: { provider: 'google', account_ids: ['forbidden'] } });
    expect(failure.body.result.isError).toBe(true);
    const [stored] = await db()`select last_used_at, verified_at from public.api_keys where id = ${key.id}`;
    expect(stored!.lastUsedAt).toBeInstanceOf(Date);
    expect(stored!.verifiedAt).toBeNull();
  });

  it('verifies an actual account-list response, scoped to the user and project', async () => {
    const answer = await call(key.key, 'tools/call', { name: 'accounts_list', arguments: { provider: 'google' } });
    expect(answer.status).toBe(200); expect(answer.body.result.isError).not.toBe(true);
    expect(JSON.parse(answer.body.result.content[0].text).accounts).toMatchObject([{ id: '1234567890' }]);
    expect(await getAssistantConnectionStatus(owner)).toMatchObject({ verified: true, hasAccounts: true });
    expect(await getAssistantConnectionStatus(other)).toMatchObject({ authorized: false, verified: false, hasAccounts: false });
    expect((await getAssistantConnectionStatus({ ...owner, userId: other.userId })).verified).toBe(false);
    await expect(updateOnboardingState(owner, { currentStep: 'complete', complete: true, selectedAgent: 'claude' })).rejects.toThrow(/run a read/);
    await updateOnboardingState(owner, { currentStep: 'complete', complete: true, selectedAgent: 'mcp' });
    expect((await getOnboardingState(owner.organizationId)).completedAt).toBeInstanceOf(Date);
    await db()`update public.api_keys set revoked_at = now() where id = ${key.id}`;
    expect((await getAssistantConnectionStatus(owner)).verified).toBe(false);
  });

  it('retains verified OAuth reads through token rotation, and rejects revocation', async () => {
    const client = await registerMcpOAuthClient({ clientName: 'Claude QA assistant', redirectUris: ['http://localhost:45893/callback'], grantTypes: ['authorization_code', 'refresh_token'], responseTypes: ['code'], tokenEndpointAuthMethod: 'none' });
    clients.push(client.clientId);
    const verifier = 'v'.repeat(64);
    const code = await createMcpAuthorizationCode(owner, { clientId: client.clientId, clientName: client.clientName, redirectUri: client.redirectUris[0]!, scopes: ['tools:read'], codeChallenge: pkceChallenge(verifier), resource: mcpResourceUrl(), state: 'local' });
    const tokens = await exchangeMcpAuthorizationCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: client.redirectUris[0]!, resource: mcpResourceUrl() });
    expect((await getAssistantConnectionStatus(owner)).verified).toBe(false);
    expect((await call(tokens.accessToken, 'tools/call', { name: 'accounts_list', arguments: { provider: 'google' } })).body.result.isError).not.toBe(true);
    expect((await getAssistantConnectionStatus(owner)).verified).toBe(true);
    expect((await getAssistantConnectionStatus(owner, 'claude')).verified).toBe(true);
    expect((await getAssistantConnectionStatus(owner, 'codex')).verified).toBe(false);
    const rotated = await exchangeMcpRefreshToken({ clientId: client.clientId, refreshToken: tokens.refreshToken, resource: mcpResourceUrl() });
    expect((await getAssistantConnectionStatus(owner)).verified).toBe(true);
    await revokeMcpOAuthToken(client.clientId, rotated.refreshToken);
    expect((await getAssistantConnectionStatus(owner)).verified).toBe(false);
  });
});

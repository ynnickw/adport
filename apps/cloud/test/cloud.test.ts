import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'adport-cloud-'));
  process.env.ADPORT_CLOUD_DB = path.join(directory, 'cloud.db');
  process.env.ADPORT_CLOUD_DEV_AUTH = 'true';
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('cloud milestone', () => {
  it('creates an isolated workspace and encrypts imported credentials', async () => {
    const { CloudStore } = await import('../src/lib/store');
    const filename = path.join(directory, 'isolated.db');
    const store = new CloudStore(filename);
    const tenant = store.bootstrap({ userId: 'u1', email: 'owner@example.test', name: 'Owner' });
    const repeated = store.bootstrap({ userId: 'u1', email: 'owner@example.test', name: 'Owner' });
    expect(repeated.workspaceId).toBe(tenant.workspaceId);

    await store.credentials(tenant.workspaceId).set({
      provider: 'meta', source: 'byo', data: { access_token: 'secret-token-that-must-not-be-plaintext' },
    });
    expect((await store.credentials(tenant.workspaceId).get('meta'))?.data.access_token)
      .toBe('secret-token-that-must-not-be-plaintext');
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(filename).toString('utf8')).not.toContain('secret-token-that-must-not-be-plaintext');
  });

  it('runs account discovery and normalized reporting through ToolRegistry', async () => {
    const [{ getCloudStore }, { discoverAndAllowAccounts, normalizedReport, runWorkspaceAudit }] = await Promise.all([
      import('../src/lib/store'), import('../src/lib/runtime'),
    ]);
    const store = getCloudStore();
    const tenant = store.bootstrap({ userId: 'runtime-user', email: 'runtime@example.test', name: 'Runtime' });
    store.connectDemo(tenant.workspaceId);
    const accounts = await discoverAndAllowAccounts(tenant.workspaceId, 'mock');
    const rows = await normalizedReport(tenant.workspaceId);
    expect(accounts.map((account) => account.id)).toEqual(['mock-1', 'mock-2']);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.provider).toBe('mock');
    expect(rows[0]?.metrics.spend).toBeTypeOf('number');
    await runWorkspaceAudit(tenant.workspaceId);
    const findings = await store.findings(tenant.workspaceId).list({ status: 'open' });
    expect(findings.some((finding) => finding.entity.name === 'Legacy Retargeting')).toBe(true);
  });

  it('keeps pending operations and findings workspace-scoped', async () => {
    const { CloudStore } = await import('../src/lib/store');
    const store = new CloudStore(path.join(directory, 'scope.db'));
    const first = store.bootstrap({ userId: 'first', email: 'first@example.test', name: 'First' });
    const second = store.bootstrap({ userId: 'second', email: 'second@example.test', name: 'Second' });
    const pending = {
      id: 'pending-1', provider: 'mock', opHash: 'hash',
      op: { tool: 'mock_set_budget', provider: 'mock', accountId: 'mock-1', kind: 'update' as const, payload: {} },
      preview: { summary: 'Preview', changes: [], coercions: [], budgetDeltas: [], serverValidated: false },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await store.pending(first.workspaceId).put(pending);
    expect(await store.pending(first.workspaceId).get(pending.id)).toBeDefined();
    expect(await store.pending(second.workspaceId).get(pending.id)).toBeUndefined();
  });

  it('binds Meta OAuth state to one user and workspace and rejects tampering or expiry', async () => {
    const { createMetaOAuthState, verifyMetaOAuthState } = await import('../src/lib/meta-oauth');
    const now = Date.now();
    const state = createMetaOAuthState('workspace-1', 'user-1', now);
    expect(verifyMetaOAuthState(state, 'workspace-1', 'user-1', now)).toBe(true);
    expect(verifyMetaOAuthState(state, 'workspace-2', 'user-1', now)).toBe(false);
    expect(verifyMetaOAuthState(state, 'workspace-1', 'user-2', now)).toBe(false);
    expect(verifyMetaOAuthState(`${state.slice(0, -1)}x`, 'workspace-1', 'user-1', now)).toBe(false);
    expect(verifyMetaOAuthState(state, 'workspace-1', 'user-1', now + 11 * 60_000)).toBe(false);
  });

  it('builds the hosted Google consent request and binds its state to one workspace', async () => {
    process.env.ADPORT_CLOUD_BASE_URL = 'https://app.adport.dev';
    process.env.GOOGLE_ADS_CLIENT_ID = 'client-id.apps.googleusercontent.com';
    process.env.GOOGLE_ADS_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'developer-token';
    const {
      createGoogleOAuthState,
      googleAuthorizationUrl,
      managedGoogleOAuthConfigured,
      verifyGoogleOAuthState,
    } = await import('../src/lib/google-oauth');
    const now = Date.now();
    const state = createGoogleOAuthState('workspace-1', 'user-1', now);
    const url = googleAuthorizationUrl(state);
    expect(managedGoogleOAuthConfigured()).toBe(true);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.adport.dev/api/oauth/google/callback');
    expect(verifyGoogleOAuthState(state, 'workspace-1', 'user-1', now)).toBe(true);
    expect(verifyGoogleOAuthState(state, 'workspace-2', 'user-1', now)).toBe(false);
    expect(verifyGoogleOAuthState(state, 'workspace-1', 'user-1', now + 11 * 60_000)).toBe(false);
  });

  it('exchanges a Google authorization code without persisting the access token', async () => {
    const { exchangeGoogleCode } = await import('../src/lib/google-oauth');
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await expect(exchangeGoogleCode('authorization-code', fetchMock)).resolves.toEqual({ refreshToken: 'refresh-token' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(requests[0]?.body).toContain('grant_type=authorization_code');
    expect(requests[0]?.body).toContain('code=authorization-code');
  });
});

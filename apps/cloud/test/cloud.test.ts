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
});

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@supabase/supabase-js';
import { AdportError, createContext, DEFAULT_POLICY, MockProvider, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { createMcpServer } from '@adport/mcp';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { PostgresPendingStore, PostgresAuditStore, resolveMembership } from '@/lib/cloud/repository';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('atomic project approval consumption', () => {
  const users: string[] = [], projects: string[] = [];
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const principal = (index = 0) => ({ organizationId: projects[index]!, userId: users[index]!, role: 'owner' as const, scopes: ['tools:read', 'tools:write'] });
  const store = (index = 0) => new PostgresPendingStore(principal(index));
  const op: WriteOperation = { provider: 'mock', tool: 'mock_set_budget', accountId: 'mock-1', kind: 'update', payload: { campaign_id: 'c1', daily_budget_micros: 12_000_000 } };
  function pending(expiresAt = new Date(Date.now() + 60_000).toISOString()): PendingOperation {
    return { id: randomUUID(), provider: 'mock', opHash: 'fixture-hash', op, preview: { summary: 'Synthetic policy fixture', changes: [], coercions: [], budgetDeltas: [], serverValidated: false }, createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt };
  }
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname)) throw new Error('These mutation fixtures require local Supabase.');
    for (let index = 0; index < 2; index++) {
      const result = await admin.auth.admin.createUser({ email: `pending-${randomUUID()}@example.com`, password: `Local-${randomUUID()}`, email_confirm: true });
      if (!result.data.user) throw result.error;
      users.push(result.data.user.id); projects.push((await resolveMembership(result.data.user.id)).organizationId);
    }
  });
  afterAll(async () => {
    if (projects.length) await db()`delete from public.organizations where id in ${db()(projects)}`;
    for (const user of users) await admin.auth.admin.deleteUser(user);
    await closeDbForTests();
  });

  it('rejects foreign, mismatched and expired tokens and permits one concurrent claimant', async () => {
    const value = pending(); await store().put(value);
    expect(await store(1).consume(value.id, value.opHash)).toBe(false);
    expect(await store().consume(value.id, 'different-hash')).toBe(false); expect(await store().get(value.id)).toBeDefined();
    const results = await Promise.all(Array.from({ length: 8 }, () => store().consume(value.id, value.opHash)));
    expect(results.filter(Boolean)).toHaveLength(1); expect(await store().get(value.id)).toBeUndefined();
    const expired = pending(new Date(Date.now() - 1).toISOString()); await store().put(expired);
    expect(await store().consume(expired.id, expired.opHash)).toBe(false);
  });

  it('checks expiry after waiting for an existing row lock', async () => {
    const value = pending(new Date(Date.now() + 1000).toISOString()); await store().put(value);
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { locked = resolve; });
    const blocker = db().begin(async sql => { await sql`select id from public.pending_operations where id = ${value.id} for update`; locked(); await gate; });
    await acquired;
    const claim = store().consume(value.id, value.opHash);
    try { await delay(Math.max(0, Date.parse(value.expiresAt) - Date.now()) + 100); }
    finally { release(); await blocker; }
    expect(await claim).toBe(false); expect(await store().get(value.id)).toBeDefined();
  });

  it('allows one MCP apply across concurrent requests and records its start before success', async () => {
    const audit = new PostgresAuditStore(principal()), engine = new PolicyEngine(DEFAULT_POLICY, store(), audit), runtime = await createContext({ includeMock: true, engine });
    const provider = runtime.ctx.providers.get('mock') as MockProvider, server = createMcpServer({ runtime }), client = new Client({ name: 'atomic-policy-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const input = { account_id: op.accountId, ...op.payload }, preview = await client.callTool({ name: op.tool, arguments: input });
      const id = (preview.structuredContent as { pending_operation_id: string }).pending_operation_id;
      const original = provider.previewWrite.bind(provider); let arrived = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(provider, 'previewWrite').mockImplementation(async (...args) => { const result = await original(...args); if (++arrived === 4) release(); await gate; return result; });
      const apply = vi.spyOn(provider, 'applyWrite');
      const responses = await Promise.all(Array.from({ length: 4 }, () => client.callTool({ name: op.tool, arguments: { ...input, pending_operation_id: id } })));
      expect(responses.filter(value => !value.isError)).toHaveLength(1); expect(responses.filter(value => value.isError)).toHaveLength(3); expect(apply).toHaveBeenCalledOnce();
      const rows = await db()<Array<{ event: string; details: Record<string, unknown> }>>`select event, details from public.audit_events where organization_id = ${projects[0]!} and pending_id = ${id} order by id`;
      expect(rows.map(value => value.event)).toEqual(['validated', 'note', 'applied']); expect(rows[1]!.details).toMatchObject({ phase: 'apply_started' });
    } finally { await Promise.allSettled([client.close(), server.close()]); }
  });

  it('keeps failed native readback approvals consumed across new runtimes and audits safe diagnostics', async () => {
    const provider = new MockProvider(), audit = new PostgresAuditStore(principal()), engine = new PolicyEngine(DEFAULT_POLICY, store(), audit), original = provider.applyWrite.bind(provider);
    const { pendingOperationId } = await engine.validate(provider, op);
    const apply = vi.spyOn(provider, 'applyWrite').mockImplementation(async (...args) => { await original(...args); throw new AdportError('PROVIDER_ERROR', 'Private native message', { resource_ids: ['c1'], upload_url: 'private-capability' }); });
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ details: { approval_consumed: true, apply_state: 'UNCONFIRMED' } });
    const next = new PolicyEngine(DEFAULT_POLICY, store(), new PostgresAuditStore(principal()));
    await expect(next.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' }); expect(apply).toHaveBeenCalledOnce();
    const rows = await db()<Array<{ event: string; summary: string; details: Record<string, unknown> }>>`select event, summary, details from public.audit_events where organization_id = ${projects[0]!} and pending_id = ${pendingOperationId} order by id`;
    expect(rows.map(value => value.event)).toEqual(['validated', 'note', 'note']); expect(rows.at(-1)!.details).toMatchObject({ phase: 'apply_failed', outcome: 'UNCONFIRMED', resourceIds: ['c1'] }); expect(JSON.stringify(rows)).not.toMatch(/Private native message|private-capability/);
  });
});

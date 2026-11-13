import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdportError } from '../src/errors.js';
import { AuditLog } from '../src/policy/audit.js';
import { PolicyEngine, hashOperation } from '../src/policy/engine.js';
import { PendingStore } from '../src/policy/pending.js';
import { policySchema } from '../src/policy/policy.js';
import type { WriteOperation } from '../src/provider.js';
import { MockProvider } from '../src/testing/mock-provider.js';

let home: string;
let provider: MockProvider;
let engine: PolicyEngine;
let pending: PendingStore;
let audit: AuditLog;

function makeEngine(policyOverrides: Record<string, unknown> = {}): PolicyEngine {
  pending = new PendingStore();
  audit = new AuditLog();
  return new PolicyEngine(policySchema.parse(policyOverrides), pending, audit);
}

function budgetOp(campaignId: string, micros: number): WriteOperation {
  return {
    tool: 'mock_set_budget',
    provider: 'mock',
    accountId: 'mock-1',
    kind: 'update',
    payload: { campaign_id: campaignId, daily_budget_micros: micros },
  };
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-test-'));
  process.env.ADPORT_HOME = home;
  provider = new MockProvider();
  engine = makeEngine();
});

afterEach(() => {
  delete process.env.ADPORT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('PolicyEngine.validate', () => {
  it('issues a pending operation with a preview', async () => {
    // c1 seed budget is 10_000_000; +20% stays under the default 25% cap.
    const outcome = await engine.validate(provider, budgetOp('c1', 12_000_000));
    expect(outcome.pendingOperationId).toMatch(/[0-9a-f-]{36}/);
    expect(outcome.preview.budgetDeltas[0]).toMatchObject({ fromMicros: 10_000_000, toMicros: 12_000_000 });
    expect(await pending.get(outcome.pendingOperationId)).toBeDefined();
  });

  it('rejects budget changes above the delta cap and audits the rejection', async () => {
    await expect(engine.validate(provider, budgetOp('c1', 20_000_000))).rejects.toMatchObject({
      code: 'POLICY_VIOLATION',
    });
    const entries = await audit.read();
    expect(entries.at(-1)).toMatchObject({ event: 'rejected', tool: 'mock_set_budget' });
  });

  it('rejects absolute budgets above max_daily_budget_micros', async () => {
    engine = makeEngine({ max_budget_delta_pct: null, max_daily_budget_micros: 50_000_000 });
    await expect(engine.validate(provider, budgetOp('c1', 60_000_000))).rejects.toMatchObject({
      code: 'POLICY_VIOLATION',
    });
  });

  it('blocks protected accounts', async () => {
    engine = makeEngine({ protected_accounts: ['mock-1'] });
    await expect(engine.validate(provider, budgetOp('c1', 10_500_000))).rejects.toMatchObject({
      code: 'POLICY_VIOLATION',
    });
  });

  it.each([
    ['google', '1234567890', ' customers/123-456-7890 '],
    ['google', '123-456-7890', '1234567890'],
    ['meta', '12345', ' act_12345 '],
    ['meta', 'act_12345', '12345'],
    ['apple', '21110001', '00021110001'],
    ['microsoft', '12345', '0012345'],
  ])('blocks provider-accepted %s aliases of protected account %s', async (providerId, protectedId, suppliedId) => {
    engine = makeEngine({ protected_accounts: [protectedId] });
    const preview = vi.spyOn(provider, 'previewWrite');
    await expect(engine.validate(provider, { ...budgetOp('c1', 12_000_000), provider: providerId, accountId: suppliedId })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(preview).not.toHaveBeenCalled();
  });

  it('coerces created campaigns to PAUSED and reports the coercion', async () => {
    const op: WriteOperation = {
      tool: 'mock_create_campaign',
      provider: 'mock',
      accountId: 'mock-1',
      kind: 'create',
      payload: { name: 'New', daily_budget_micros: 1_000_000, status: 'ENABLED' },
    };
    const outcome = await engine.validate(provider, op);
    expect(outcome.preview.coercions).toEqual([
      'status coerced to PAUSED by policy (paused_creation)',
    ]);
  });
});

describe('PolicyEngine.apply', () => {
  it('lets only one independent engine apply when the same approval is submitted concurrently', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op);
    const original = provider.previewWrite.bind(provider); let arrived = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(provider, 'previewWrite').mockImplementation(async (...args) => { const preview = await original(...args); if (++arrived === 8) release(); await gate; return preview; });
    const apply = vi.spyOn(provider, 'applyWrite');
    const engines = Array.from({ length: 8 }, () => new PolicyEngine(engine.policy, new PendingStore(), new AuditLog()));
    const outcomes = await Promise.allSettled(engines.map(value => value.apply(provider, op, pendingOperationId)));
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected').map(value => value.reason.code)).toEqual(Array(7).fill('PENDING_NOT_FOUND'));
    expect(apply).toHaveBeenCalledOnce(); expect(await pending.get(pendingOperationId)).toBeUndefined();
    expect((await audit.read()).map(entry => entry.event)).toEqual(['validated', 'note', 'applied']);
  });

  it('consumes the approval and retains safe audit IDs when a native write succeeds but its readback fails', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), original = provider.applyWrite.bind(provider);
    const apply = vi.spyOn(provider, 'applyWrite').mockImplementation(async (...args) => { await original(...args); throw new AdportError('PROVIDER_ERROR', 'Native receipt unconfirmed', { resource_ids: ['c1'], upload_url: 'private-capability', message: 'private-message', http_status: 422 }); });
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: ['c1'], http_status: 422, approval_consumed: true, apply_state: 'UNCONFIRMED' } });
    expect(provider.listCampaigns('mock-1').find(value => value.id === 'c1')?.dailyBudgetMicros).toBe(12_000_000);
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(apply).toHaveBeenCalledOnce(); expect(await pending.get(pendingOperationId)).toBeUndefined();
    const entries = await audit.read();
    expect(entries.at(-1)).toMatchObject({ event: 'note', details: { phase: 'apply_failed', outcome: 'UNCONFIRMED', error_code: 'PROVIDER_ERROR', resourceIds: ['c1'] } });
    expect(JSON.stringify(entries)).not.toMatch(/private-capability|private-message|Native receipt unconfirmed/);
    expect(entries.some(entry => entry.event === 'applied')).toBe(false);
  });

  it('does not expose an unexpected exception and never reopens its consumed approval', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op);
    const apply = vi.spyOn(provider, 'applyWrite').mockRejectedValue(new Error('https://private.invalid?token=secret'));
    const error = await engine.apply(provider, op, pendingOperationId).catch(error => error);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', details: { approval_consumed: true, apply_state: 'UNCONFIRMED' } });
    expect(JSON.stringify(error.toJSON())).not.toMatch(/private.invalid|token=secret/);
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' }); expect(apply).toHaveBeenCalledOnce();
  });

  it('preserves structured native diagnostics for the caller without adding them to failure audits', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), details = [{ field: 'budget', code: 'MIN_VALUE' }];
    vi.spyOn(provider, 'applyWrite').mockRejectedValue(new AdportError('PROVIDER_ERROR', 'Native validation rejected', details));
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ details: { native_details: details, approval_consumed: true } });
    expect((await audit.read()).at(-1)?.details).toEqual({ phase: 'apply_failed', outcome: 'UNCONFIRMED', error_code: 'PROVIDER_ERROR' });
  });

  it.each(['start', 'completion', 'failure'] as const)('fails safely if the %s audit cannot be persisted', async stage => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), original = audit.append.bind(audit);
    vi.spyOn(audit, 'append').mockImplementation(async entry => {
      const phase = (entry.details as { phase?: string } | undefined)?.phase;
      if (stage === 'start' && phase === 'apply_started' || stage === 'completion' && entry.event === 'applied' || stage === 'failure' && phase === 'apply_failed') throw new Error('private-database-failure');
      await original(entry);
    });
    const apply = vi.spyOn(provider, 'applyWrite');
    if (stage === 'failure') apply.mockRejectedValue(new AdportError('PROVIDER_ERROR', 'Native failure', { resource_ids: ['c1'] }));
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { approval_consumed: true, apply_state: stage === 'start' ? 'NOT_STARTED' : stage === 'completion' ? 'APPLIED_AUDIT_UNCONFIRMED' : 'UNCONFIRMED', ...(stage === 'completion' ? { resource_ids: ['c1'] } : {}), ...(stage === 'failure' ? { failure_audit_recorded: false } : {}) } });
    expect(apply).toHaveBeenCalledTimes(stage === 'start' ? 0 : 1); expect(await pending.get(pendingOperationId)).toBeUndefined();
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
  });

  it('does not execute an approval that expires while its final preview is running', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId, preview } = await engine.validate(provider, op), stored = (await pending.get(pendingOperationId))!;
    vi.spyOn(provider, 'previewWrite').mockImplementation(async () => { await pending.put({ ...stored, expiresAt: new Date(Date.now() - 1).toISOString() }); return preview; });
    const apply = vi.spyOn(provider, 'applyWrite');
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' }); expect(apply).not.toHaveBeenCalled();
  });

  it('checks the deadline again if recording the start audit crosses the approval expiry', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), original = audit.append.bind(audit);
    const stored = (await pending.get(pendingOperationId))!, clock = vi.spyOn(Date, 'now');
    vi.spyOn(audit, 'append').mockImplementation(async entry => { await original(entry); if ((entry.details as { phase?: string } | undefined)?.phase === 'apply_started') clock.mockReturnValue(Date.parse(stored.expiresAt) + 1); });
    const apply = vi.spyOn(provider, 'applyWrite');
    try {
      await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_EXPIRED', details: { approval_consumed: true, apply_state: 'NOT_STARTED' } });
      expect(apply).not.toHaveBeenCalled(); expect((await audit.read()).at(-1)).toMatchObject({ details: { outcome: 'NOT_STARTED' } });
    } finally { clock.mockRestore(); }
  });

  it('audits partial-result warnings while excluding arbitrary provider details and reusable capabilities', async () => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    vi.spyOn(provider, 'applyWrite').mockResolvedValue({ applied: true, resourceIds: ['c1'], warnings: ['Only 1 of 2 records was confirmed. Inspect the remaining outcome.'], details: { upload_url: 'private-capability-never-audit', raw_identifier: 'private-event-identifier' } });
    await engine.apply(provider, op, pendingOperationId);
    const entries = await audit.read();
    expect(entries.at(-1)).toMatchObject({ event: 'applied', details: { resourceIds: ['c1'], warnings: ['Only 1 of 2 records was confirmed. Inspect the remaining outcome.'] } });
    expect(JSON.stringify(entries)).not.toMatch(/private-capability-never-audit|private-event-identifier/);
  });

  it('rechecks the budget delta cap against changed live state before applying', async () => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    await provider.applyWrite(budgetOp('c1', 5_000_000), engine.guard());
    const apply = vi.spyOn(provider, 'applyWrite');
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(apply).not.toHaveBeenCalled();
    expect(provider.listCampaigns('mock-1').find(c => c.id === 'c1')?.dailyBudgetMicros).toBe(5_000_000);
    expect((await audit.read()).at(-1)?.event).toBe('rejected');
  });

  it('requires a new preview if a provider resolves a different proposed amount, even within caps', async () => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId, preview } = await engine.validate(provider, op);
    vi.spyOn(provider, 'previewWrite').mockResolvedValue({ ...preview, budgetDeltas: [{ ...preview.budgetDeltas[0]!, toMicros: 11_000_000 }] });
    const apply = vi.spyOn(provider, 'applyWrite');
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(apply).not.toHaveBeenCalled();
    expect((await audit.read()).at(-1)).toMatchObject({ event: 'rejected', pendingId: pendingOperationId });
  });

  it('applies a validated operation and audits it', async () => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    const outcome = await engine.apply(provider, op, pendingOperationId);
    expect(outcome.result.applied).toBe(true);
    expect(provider.listCampaigns('mock-1').find((c) => c.id === 'c1')?.dailyBudgetMicros).toBe(12_000_000);
    // Pending id is single-use.
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({
      code: 'PENDING_NOT_FOUND',
    });
    const events = (await audit.read()).map((e) => e.event);
    expect(events).toEqual(['validated', 'note', 'applied']);
    expect((await audit.read())[1]).toMatchObject({ details: { phase: 'apply_started', outcome: 'UNCONFIRMED' } });
  });

  it('rejects apply when the operation differs from what was validated', async () => {
    const { pendingOperationId } = await engine.validate(provider, budgetOp('c1', 12_000_000));
    await expect(engine.apply(provider, budgetOp('c1', 12_400_000), pendingOperationId)).rejects.toMatchObject(
      { code: 'PENDING_MISMATCH' },
    );
  });

  it.each([
    { max_daily_budget_micros: 11_000_000 },
    { max_budget_delta_pct: 10 },
    { pending_ttl_minutes: 5 },
  ])('requires a new preview after policy changes to %j', async (policy) => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    const apply = vi.spyOn(provider, 'applyWrite');
    engine = makeEngine(policy);

    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({
      code: 'PENDING_MISMATCH',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(provider.listCampaigns('mock-1').find((c) => c.id === 'c1')?.dailyBudgetMicros).toBe(10_000_000);
  });

  it.each([true, false])('requires a new preview when paused creation changes from %s', async (paused) => {
    engine = makeEngine({ paused_creation: paused });
    const op: WriteOperation = {
      tool: 'mock_create_campaign', provider: 'mock', accountId: 'mock-1', kind: 'create',
      payload: { name: 'New', daily_budget_micros: 1_000_000, status: 'ENABLED' },
    };
    const { pendingOperationId } = await engine.validate(provider, op);
    const apply = vi.spyOn(provider, 'applyWrite');
    engine = makeEngine({ paused_creation: !paused });

    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(apply).not.toHaveBeenCalled();
    expect(provider.listCampaigns('mock-1').some((c) => c.name === 'New')).toBe(false);
  });

  it('applies after a new preview under the updated policy', async () => {
    const op = budgetOp('c1', 12_000_000);
    const original = await engine.validate(provider, op);
    engine = makeEngine({ max_budget_delta_pct: 20 });
    await expect(engine.apply(provider, op, original.pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    const refreshed = await engine.validate(provider, op);
    expect((await engine.apply(provider, op, refreshed.pendingOperationId)).result.applied).toBe(true);
  });

  it('does not invalidate a preview when protected accounts are reordered', async () => {
    engine = makeEngine({ protected_accounts: ['other-1', 'other-2'] });
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    engine = makeEngine({ protected_accounts: ['other-2', 'other-1', 'other-1'] });
    expect((await engine.apply(provider, op, pendingOperationId)).result.applied).toBe(true);
  });

  it('requires a fresh preview for tokens issued before policy binding', async () => {
    const op = budgetOp('c1', 12_000_000);
    const { pendingOperationId } = await engine.validate(provider, op);
    const stored = (await pending.get(pendingOperationId))!;
    await pending.put({ ...stored, opHash: hashOperation(op) });
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  });

  it('rejects approvals from the previous apply protocol before any native execution', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), stored = (await pending.get(pendingOperationId))!;
    // Produced by the pre-single-attempt hashOperation for this exact fixture
    // and DEFAULT_POLICY. Older deployments must not share approvals with this protocol.
    await pending.put({ ...stored, opHash: '4c6605c1eaeb29e2440cd213a2f7ab2624d2b5688696574b4e947ea11e0ab867' });
    const apply = vi.spyOn(provider, 'applyWrite');
    await expect(engine.apply(provider, op, pendingOperationId)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' }); expect(apply).not.toHaveBeenCalled();
    const current = await engine.validate(provider, op);
    expect((await engine.apply(provider, op, current.pendingOperationId)).result.applied).toBe(true);
  });

  it('rejects expired pending operations', async () => {
    const op = budgetOp('c1', 12_000_000);
    const past = new Date(Date.now() - 60_000).toISOString();
    await pending.put({
      id: 'expired-id',
      provider: 'mock',
      opHash: hashOperation(op),
      op,
      preview: { summary: '', changes: [], coercions: [], budgetDeltas: [], serverValidated: false },
      createdAt: past,
      expiresAt: past,
    });
    await expect(engine.apply(provider, op, 'expired-id')).rejects.toMatchObject({
      code: 'PENDING_EXPIRED',
    });
  });

  it('rejects unknown pending ids', async () => {
    await expect(
      engine.apply(provider, budgetOp('c1', 12_000_000), '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(AdportError);
  });
});

describe('file-backed atomic approval consumption', () => {
  it('competes across real Node processes without an in-process lock', async () => {
    const op = budgetOp('c1', 12_000_000), { pendingOperationId } = await engine.validate(provider, op), stored = (await pending.get(pendingOperationId))!;
    const script = "const {PendingStore}=await import(process.argv[1]);const store=new PendingStore(process.argv[2]);process.stdout.write(await store.consume(process.argv[3],process.argv[4])?'claimed':'unavailable');";
    // Turbo's test task builds this package first; exercise its actual public
    // Node entry point in separate processes, not a duplicate lock algorithm.
    const run = promisify(execFile), module = new URL('../dist/index.js', import.meta.url).href;
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script, module, path.join(home, 'pending'), pendingOperationId, stored.opHash])));
    expect(outcomes.filter(value => value.stdout === 'claimed')).toHaveLength(1);
    expect(outcomes.filter(value => value.stdout === 'unavailable')).toHaveLength(7);
    expect(await pending.get(pendingOperationId)).toBeUndefined();
  });

  it('leaves an unexpired approval untouched when a different hash attempts consumption', async () => {
    const { pendingOperationId } = await engine.validate(provider, budgetOp('c1', 12_000_000));
    expect(await pending.consume(pendingOperationId, 'wrong-hash')).toBe(false); expect(await pending.get(pendingOperationId)).toBeDefined();
  });
});

it('does not allow the preview gate to be disabled in configuration', () => {
  expect(policySchema.safeParse({ require_validation: false }).success).toBe(false);
});

describe('hashOperation', () => {
  it('is stable under key order', () => {
    const a = hashOperation({
      tool: 't',
      provider: 'p',
      accountId: 'a',
      kind: 'update',
      payload: { x: 1, y: { b: 2, a: 3 } },
    });
    const b = hashOperation({
      tool: 't',
      provider: 'p',
      accountId: 'a',
      kind: 'update',
      payload: { y: { a: 3, b: 2 }, x: 1 },
    });
    expect(a).toBe(b);
  });
});

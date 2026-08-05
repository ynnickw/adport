import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(events).toEqual(['validated', 'applied']);
  });

  it('rejects apply when the operation differs from what was validated', async () => {
    const { pendingOperationId } = await engine.validate(provider, budgetOp('c1', 12_000_000));
    await expect(engine.apply(provider, budgetOp('c1', 12_400_000), pendingOperationId)).rejects.toMatchObject(
      { code: 'PENDING_MISMATCH' },
    );
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

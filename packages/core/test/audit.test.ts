import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRunner } from '../src/audit/runner.js';
import { FindingsStore } from '../src/audit/store.js';
import { createContext } from '../src/context.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-audit-test-'));
  process.env.ADPORT_HOME = home;
});

afterEach(() => {
  delete process.env.ADPORT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('AuditRunner + core-performance pack', () => {
  it('finds the zero-conversion campaign and proposes a pause action', async () => {
    const { ctx } = await createContext({ includeMock: true });
    const runner = new AuditRunner(ctx.providers);
    const result = await runner.run({ dateRange: 'last_30_days' });

    const zombie = result.findings.find((f) => f.ruleId === 'zero-conversion-spend');
    expect(zombie).toBeDefined();
    expect(zombie!.entity.name).toBe('Legacy Retargeting');
    expect(zombie!.severity).toBe('critical'); // ~8.64/day * 30 days >> 3x threshold
    expect(zombie!.proposedAction).toEqual({
      tool: 'mock_set_campaign_status',
      input: { account_id: 'mock-1', campaign_id: 'c4', status: 'PAUSED' },
    });
    // Findings persist to disk (durable across restarts).
    const stored = await new FindingsStore().get(zombie!.id);
    expect(stored?.status).toBe('open');
    expect(result.counts.critical).toBeGreaterThanOrEqual(1);
  });

  it('does not reopen dismissed findings on later runs', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const first = await new AuditRunner(ctx.providers).run({});
    const finding = first.findings.find((f) => f.ruleId === 'zero-conversion-spend')!;

    await registry.call('recommendation_dismiss', { finding_id: finding.id }, ctx);
    const second = await new AuditRunner(ctx.providers).run({});
    expect(second.findings.find((f) => f.id === finding.id)).toBeUndefined();
    expect((await new FindingsStore().get(finding.id))!.status).toBe('dismissed');
  });
});

describe('recommendation tools', () => {
  it('previews audit findings without persisting them', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const result = (await registry.call('audit_preview', {}, ctx)) as { findings: Array<{ id: string }> };
    expect(result.findings.length).toBeGreaterThan(0);
    expect(await new FindingsStore().get(result.findings[0]!.id)).toBeUndefined();
  });

  it('applies a proposed action through the two-step policy gate and marks the finding applied', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    await registry.call('audit_run', {}, ctx);

    const listed = (await registry.call('recommendations_list', {}, ctx)) as {
      findings: Array<{ id: string; ruleId: string }>;
    };
    const finding = listed.findings.find((f) => f.ruleId === 'zero-conversion-spend')!;

    // Step 1: validate — returns the dry-run preview + pending token.
    const first = (await registry.call('recommendation_apply', { finding_id: finding.id }, ctx)) as {
      result: { status: string; pending_operation_id: string };
    };
    expect(first.result.status).toBe('pending_validation');

    // Step 2: apply with the token — campaign pauses, finding flips to applied.
    const second = (await registry.call(
      'recommendation_apply',
      { finding_id: finding.id, pending_operation_id: first.result.pending_operation_id },
      ctx,
    )) as { result: { status: string } };
    expect(second.result.status).toBe('applied');
    expect((await new FindingsStore().get(finding.id))!.status).toBe('applied');

    const campaigns = (await registry.call('mock_list_campaigns', { account_id: 'mock-1' }, ctx)) as {
      campaigns: Array<{ id: string; status: string }>;
    };
    expect(campaigns.campaigns.find((c) => c.id === 'c4')!.status).toBe('PAUSED');
  });

  it('refuses to apply findings without a proposed action', async () => {
    const { ctx, registry } = await createContext({ includeMock: true });
    const store = new FindingsStore();
    await store.save({
      id: 'manual:mock:mock-1:c1',
      ruleId: 'low-ctr',
      severity: 'warn',
      provider: 'mock',
      accountId: 'mock-1',
      entity: { level: 'campaign', id: 'c1', name: 'Brand Search' },
      title: 't',
      detail: 'd',
      recommendation: 'Review creative',
      metrics: {},
      dateRange: { start: '2026-07-01', end: '2026-07-31' },
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(registry.call('recommendation_apply', { finding_id: 'manual:mock:mock-1:c1' }, ctx)).rejects.toThrow(
      /human judgment/,
    );
  });
});

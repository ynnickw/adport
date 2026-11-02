import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { PendingStore } from '../src/policy/pending.js';
import { AuditLog } from '../src/policy/audit.js';
import { DEFAULT_POLICY } from '../src/policy/policy.js';
import { withProjectRouting } from '../src/tools/projects.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('project routing through the shared registry', () => {
  it('requires an explicit project, preserves independent policies and cannot move pending approvals between projects', async () => {
    const ids: string[] = [randomUUID(), randomUUID()];
    const runtimes = await Promise.all(ids.map(async id => {
      const dir = mkdtempSync(join(tmpdir(), 'adport-projects-')); directories.push(dir);
      return createContext({ includeMock: true, engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))) });
    }));
    const routed = withProjectRouting(runtimes[0]!, {
      list: async () => ids.map(id => ({ id, name: id, organization_name: 'Company', role: 'owner', providers: ['mock'] })),
      resolve: async id => {
        const runtime = runtimes[ids.indexOf(id)];
        if (!runtime) throw new Error('Unauthorized project');
        return runtime;
      },
    });
    await expect(routed.registry.call('accounts_list', {}, routed.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const payload = { account_id: 'mock-1', campaign_id: 'c1', status: 'PAUSED' };
    const preview = await routed.registry.call('mock_set_campaign_status', { project_id: ids[0], ...payload }, routed.ctx) as { pending_operation_id: string };
    await expect(routed.registry.call('mock_set_campaign_status', { project_id: ids[1], ...payload, pending_operation_id: preview.pending_operation_id }, routed.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    await expect(routed.registry.call('mock_set_campaign_status', { project_id: ids[0], ...payload, pending_operation_id: preview.pending_operation_id }, routed.ctx)).resolves.toMatchObject({ applied: true });
    expect(runtimes[0]!.registry.get('mock_set_campaign_status').input.shape).not.toHaveProperty('project_id');
  });
});

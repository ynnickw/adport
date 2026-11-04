import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, withProjectRouting, type PolicyEngine } from '@adport/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_URI, viewForTool } from '../src/ui.js';
import { PROVIDER_LOGOS } from '../src/provider-logos.js';
import { providerModules } from './provider-fixtures.js';

it('maps every registered tool to a branded view and supplies a structured review for every guarded preview and apply', async () => {
  const home = mkdtempSync(join(tmpdir(), 'adport-widget-coverage-'));
  const previous = process.env.ADPORT_HOME; process.env.ADPORT_HOME = home;
  const client = new Client({ name: 'widget-coverage', version: '1' });
  const runtime = withProjectRouting(await createContext({ providerModules: providerModules(), includeMock: true }), {
    list: async () => [], resolve: async () => { throw new Error('No provider access in this test'); },
  });
  const server = createMcpServer({ runtime });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const current = await client.readResource({ uri: ADPORT_UI_URI });
    const previous = await client.readResource({ uri: 'ui://adport/insight-card-v2.html' });
    expect(current.contents[0]?.text).toContain('Hold to apply');
    expect(previous.contents[0]?.text).toBe(current.contents[0]?.text);
    const scanned = (await client.listTools()).tools;
    expect(scanned).toHaveLength(runtime.registry.list().length);
    for (const source of runtime.registry.list()) {
      const tool = scanned.find(item => item.name === source.name)!;
      expect(tool._meta, source.name).toMatchObject({ ui: { resourceUri: ADPORT_UI_URI } });
      expect(tool._meta?.['openai/outputTemplate'], source.name).toBe(ADPORT_UI_URI);
      const view = viewForTool(source.name, source.annotations.readOnly ?? false);
      if (source.name === 'projects_list') expect(view).toBe('data');
      if (source.annotations.readOnly && !/^(accounts_list|report|audit_|recommendations_)/.test(source.name)) expect(view, source.name).toBe('data');
      if (source.namespace !== 'core' && source.namespace !== 'audit' && source.namespace !== 'mock') expect(PROVIDER_LOGOS[source.namespace], source.name).toContain('<svg');
    }
    // Exercise each actual guarded handler without making network requests or
    // duplicating the tool definitions. Input validation is covered by providers.
    let guarded = 0;
    const base = await createContext({ providerModules: providerModules(), includeMock: true });
    for (const source of base.registry.list()) {
      if (!source.input.shape.pending_operation_id || source.namespace === 'audit') continue;
      guarded++;
      const planned = { summary: 'Review "Example"', changes: ['~ status ACTIVE → PAUSED'], coercions: [], budgetDeltas: [], serverValidated: false };
      const engine = {
        validate: async (_provider: unknown, op: { tool: string }) => { expect(op.tool).toBe(source.name); return { pendingOperationId: 'pending', expiresAt: '2099-01-01T00:00:00Z', preview: planned }; },
        apply: async (_provider: unknown, op: { tool: string }, pending: string) => { expect(op.tool).toBe(source.name); expect(pending).toBe('pending'); return { result: { applied: true, resourceIds: ['example'] }, preview: planned }; },
      } as unknown as PolicyEngine;
      const args = { account_id: 'example', name: 'Example', status: 'PAUSED', arbitrary_setting: { enabled: false } };
      const preview = await source.handler(args as never, { ...base.ctx, engine });
      const applied = await source.handler({ ...args, pending_operation_id: 'pending' } as never, { ...base.ctx, engine });
      for (const result of [preview, applied]) {
        expect(source.output!.safeParse(result).success, source.name).toBe(true);
        expect(result, source.name).toHaveProperty('preview.review.provider', source.name.startsWith('media_') ? 'media' : source.namespace);
        expect(result, source.name).toHaveProperty('preview.review.accountId', 'example');
        expect(result, source.name).toHaveProperty('preview.review.fields');
      }
    }
    expect(guarded).toBeGreaterThan(60);
  } finally {
    await client.close(); await server.close();
    if (previous === undefined) delete process.env.ADPORT_HOME; else process.env.ADPORT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

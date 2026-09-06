import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AdportError, createContext } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_DOMAIN, ADPORT_UI_URI } from '../src/ui.js';

let home: string;
let client: Client;

function textOf(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-mcp-test-'));
  process.env.ADPORT_HOME = home;
  const runtime = await createContext({ includeMock: true });
  const server = createMcpServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  delete process.env.ADPORT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('adport MCP server', () => {
  it('preserves CLI connection guidance for local MCP clients', async () => {
    const result = await client.callTool({ name: 'accounts_list', arguments: { provider: 'google' } });
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toMatchObject({
      error: 'NOT_CONNECTED', message: expect.stringContaining('adport connect google'),
    });
  });

  it('uses hosted guidance for missing providers without weakening errors or inventing demo data', async () => {
    const runtime = await createContext();
    const notConnectedMessage = 'Open Connections in the dashboard, then enable account access in Accounts.';
    const server = createMcpServer({ runtime, notConnectedMessage });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const hosted = new Client({ name: 'cloud-connection-guidance', version: '1' });
    await Promise.all([server.connect(st), hosted.connect(ct)]);
    try {
      for (const request of [
        { name: 'accounts_list', arguments: {} },
        { name: 'accounts_list', arguments: { provider: 'demo' } },
        { name: 'report', arguments: { provider: 'google' } },
      ]) {
        const result = await hosted.callTool(request);
        expect(result.isError).toBe(true);
        const expected = { error: 'NOT_CONNECTED', message: notConnectedMessage };
        expect(textOf(result as never)).toEqual(expected);
        expect(result.structuredContent).toMatchObject(expected);
        expect(result.structuredContent).not.toHaveProperty('accounts');
        expect(result.structuredContent).not.toHaveProperty('rows');
        expect(JSON.stringify(result)).not.toMatch(/adport connect|--demo/);
      }
      runtime.ctx.authorizeToolCall = () => { throw new AdportError('POLICY_VIOLATION', 'Account access denied.'); };
      const denied = await hosted.callTool({ name: 'accounts_list', arguments: {} });
      expect(denied.isError).toBe(true);
      expect(textOf(denied as never)).toEqual({ error: 'POLICY_VIOLATION', message: 'Account access denied.' });
    } finally {
      await hosted.close();
      await server.close();
    }
  });

  it('marks synthetic success and error responses in both text and structured content', async () => {
    const runtime = await createContext({ includeMock: true });
    runtime.dataSource = 'synthetic';
    const server = createMcpServer({ runtime });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const reviewer = new Client({ name: 'synthetic-test', version: '1' });
    await Promise.all([server.connect(st), reviewer.connect(ct)]);
    try {
      for (const args of [{}, { provider: 'not-connected' }]) {
        const result = await reviewer.callTool({ name: 'accounts_list', arguments: args });
        expect(result.structuredContent).toMatchObject({ data_source: 'synthetic' });
        expect(textOf(result as Parameters<typeof textOf>[0])).toMatchObject({ data_source: 'synthetic' });
      }
    } finally { await reviewer.close(); }
  });
  it('uses the orange dot for local MCP connections by default', () => {
    expect(client.getServerVersion()?.icons).toEqual([
      { src: 'https://app.adport.dev/icon.svg?brand=orange-dot-v2', mimeType: 'image/svg+xml', sizes: ['any'] },
    ]);
  });

  it('advertises configured brand icons to MCP clients', async () => {
    const runtime = await createContext({ includeMock: true });
    const brandedServer = createMcpServer({
      runtime,
      icons: [{ src: 'https://app.adport.dev/icon.svg?brand=orange-dot-v2', mimeType: 'image/svg+xml', sizes: ['any'] }],
    });
    const [brandedClientTransport, brandedServerTransport] = InMemoryTransport.createLinkedPair();
    const brandedClient = new Client({ name: 'branded-client', version: '0.0.0' });
    await Promise.all([brandedServer.connect(brandedServerTransport), brandedClient.connect(brandedClientTransport)]);
    try {
      expect(brandedClient.getServerVersion()?.icons).toEqual([
        { src: 'https://app.adport.dev/icon.svg?brand=orange-dot-v2', mimeType: 'image/svg+xml', sizes: ['any'] },
      ]);
    } finally {
      await brandedClient.close();
    }
  });

  it('exposes registry tools with annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('accounts_list');
    expect(names).toContain('report');
    expect(names).toContain('mock_set_budget');
    const remove = tools.find((t) => t.name === 'mock_remove_campaign');
    expect(remove?.annotations?.destructiveHint).toBe(true);
    expect(remove?.annotations?.openWorldHint).toBe(false);
    const list = tools.find((t) => t.name === 'accounts_list');
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(list?.annotations?.openWorldHint).toBe(true);
    const persistedFindings = tools.find((t) => t.name === 'recommendations_list');
    expect(persistedFindings?.annotations?.openWorldHint).toBe(false);
    const previewAudit = tools.find((t) => t.name === 'audit_preview');
    expect(previewAudit?.annotations?.readOnlyHint).toBe(true);
    expect(previewAudit?.annotations?.openWorldHint).toBe(true);
    const persistedAudit = tools.find((t) => t.name === 'audit_run');
    expect(persistedAudit?.annotations?.readOnlyHint).toBe(false);
    expect(persistedAudit?.annotations?.openWorldHint).toBe(true);
    const applyFinding = tools.find((t) => t.name === 'recommendation_apply');
    expect(applyFinding?.annotations?.openWorldHint).toBe(true);
    expect(list?.title).toBe('Show connected ad accounts');
    expect(list?._meta).toMatchObject({
      ui: { resourceUri: ADPORT_UI_URI },
      'ui/resourceUri': ADPORT_UI_URI,
    });
  });

  it('serves a self-contained MCP App with a narrow CSP', async () => {
    const resources = await client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: ADPORT_UI_URI, mimeType: 'text/html;profile=mcp-app' }),
    ]));

    const resource = await client.readResource({ uri: ADPORT_UI_URI });
    const content = resource.contents[0] as { text?: string; mimeType?: string; _meta?: Record<string, unknown> };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('ui/initialize');
    expect(content.text).toContain('ui/notifications/tool-result');
    expect(content.text).toContain('adport.dev');
    expect(content.text).not.toContain('evidence before action');
    expect(content.text).not.toMatch(/https?:\/\//);
    const script = content.text?.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(content._meta).toEqual({
      ui: {
        domain: ADPORT_UI_DOMAIN,
        prefersBorder: false,
        csp: { connectDomains: [], resourceDomains: [] },
      },
      'openai/widgetDomain': ADPORT_UI_DOMAIN,
    });
  });

  it('answers accounts_list', async () => {
    const result = await client.callTool({ name: 'accounts_list', arguments: {} });
    const parsed = textOf(result as never) as { accounts: Array<{ id: string }> };
    expect(parsed.accounts.map((a) => a.id)).toEqual(['mock-1', 'mock-2']);
    expect(result.structuredContent).toMatchObject({
      accounts: expect.any(Array),
      _adport: { tool: 'accounts_list', view: 'accounts' },
    });
  });

  it('keeps complete text fallback for hosts that do not advertise MCP Apps', async () => {
    // The client in this suite declares no UI extension capability.
    for (const request of [
      { name: 'accounts_list', arguments: {} },
      { name: 'report', arguments: { provider: 'mock', date_range: 'last_7_days', level: 'campaign', metrics: ['spend', 'clicks'] } },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as Record<string, unknown>;
      const { _adport, ...payload } = structured;
      expect(_adport).toMatchObject({ tool: request.name });
      expect(textOf(result as never)).toEqual(payload);
      if (request.name === 'report') expect(payload.rows).toEqual(expect.arrayContaining([expect.objectContaining({ metrics: expect.any(Object) })]));
    }
  });

  it('enforces the two-step write over MCP (M0 exit criterion)', async () => {
    const args = { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 11_500_000 };

    const previewResult = await client.callTool({ name: 'mock_set_budget', arguments: args });
    const first = textOf(previewResult as never) as { status: string; pending_operation_id: string; preview: { budgetDeltas: unknown[] } };
    expect(first.status).toBe('pending_validation');
    expect(first.preview.budgetDeltas).toHaveLength(1);

    expect(previewResult.structuredContent).toMatchObject({
      status: 'pending_validation',
      _adport: { tool: 'mock_set_budget', view: 'operation' },
    });

    const second = textOf(
      (await client.callTool({
        name: 'mock_set_budget',
        arguments: { ...args, pending_operation_id: first.pending_operation_id },
      })) as never,
    ) as { status: string };
    expect(second.status).toBe('applied');

    const campaigns = textOf(
      (await client.callTool({ name: 'mock_list_campaigns', arguments: { account_id: 'mock-1' } })) as never,
    ) as { campaigns: Array<{ id: string; dailyBudgetMicros: number }> };
    expect(campaigns.campaigns.find((c) => c.id === 'c1')?.dailyBudgetMicros).toBe(11_500_000);
  });

  it('surfaces policy violations as tool errors', async () => {
    const result = (await client.callTool({
      name: 'mock_set_budget',
      arguments: { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 99_000_000 },
    }));
    expect(result.isError).toBe(true);
    const parsed = textOf(result as never) as { error: string };
    expect(parsed.error).toBe('POLICY_VIOLATION');
    expect(result.structuredContent).toMatchObject({
      error: 'POLICY_VIOLATION',
      _adport: { tool: 'mock_set_budget', view: 'operation' },
    });
    const { _adport, ...payload } = result.structuredContent as Record<string, unknown>;
    expect(payload).toEqual(parsed);
  });

  it.each([
    new Error('Authorization: Bearer synthetic-private-secret at /private/internal/config'),
    'synthetic-private-secret',
    { toString: () => { throw new Error('must not stringify unknown exceptions'); } },
  ])('does not disclose unexpected exceptions in tool or widget responses (%#)', async (failure) => {
    const runtime = await createContext({ includeMock: true });
    runtime.ctx.authorizeToolCall = () => { throw failure; };
    const server = createMcpServer({ runtime });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const errorClient = new Client({ name: 'error-privacy-test', version: '0.0.0' });
    await Promise.all([server.connect(st), errorClient.connect(ct)]);
    try {
      for (const request of [
        { name: 'accounts_list', arguments: {} },
        { name: 'mock_list_campaigns', arguments: { account_id: 'mock-1' } },
      ]) {
        const result = await errorClient.callTool(request);
        expect(result.isError).toBe(true);
        const payload = textOf(result as never);
        expect(payload).toEqual({
          error: 'INTERNAL',
          message: 'Adport could not complete this request. If this was a write, check its status before retrying. Contact support if the problem persists.',
        });
        expect(JSON.stringify(result)).not.toMatch(/synthetic-private-secret|\/private\/internal|must not stringify/);
        if (request.name === 'accounts_list') {
          expect(result.structuredContent).toMatchObject({ ...payload as object, _adport: { view: 'accounts' } });
        }
      }
    } finally {
      await errorClient.close();
    }
  });

  it('omits tools outside a remote API key scope', async () => {
    const runtime = await createContext({ includeMock: true });
    const scopedServer = createMcpServer({ runtime, scopes: ['tools:read'] });
    const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
    const scopedClient = new Client({ name: 'read-only-client', version: '0.0.0' });
    await Promise.all([scopedServer.connect(scopedServerTransport), scopedClient.connect(scopedClientTransport)]);
    try {
      const names = (await scopedClient.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('accounts_list');
      expect(names).toContain('mock_list_campaigns');
      expect(names).not.toContain('mock_set_budget');
      expect(names).not.toContain('mock_remove_campaign');
    } finally {
      await scopedClient.close();
    }
  });

  it('keeps plan-blocked write tools discoverable and explains the entitlement without an upsell', async () => {
    const runtime = await createContext({ includeMock: true });
    const scopedServer = createMcpServer({
      runtime,
      scopes: ['tools:read'],
      scopeDenials: {
        'tools:write': {
          code: 'PLAN_LIMIT',
          message: 'MCP write tools are not included in the current Free plan. They require operator or higher with write access. No changes were made.',
          data: {
            planLimit: {
              kind: 'write_access',
              currentPlan: 'Free',
              recommendedPlan: 'operator',
              message: 'MCP write tools are not included in the current Free plan. They require operator or higher with write access. No changes were made.',
            },
          },
        },
      },
    });
    const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
    const scopedClient = new Client({ name: 'free-plan-client', version: '0.0.0' });
    await Promise.all([scopedServer.connect(scopedServerTransport), scopedClient.connect(scopedClientTransport)]);
    try {
      const tools = (await scopedClient.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain('mock_set_budget');
      expect(tools.find((tool) => tool.name === 'mock_set_budget')?.description).toContain('Unavailable on the current plan');

      const result = await scopedClient.callTool({
        name: 'mock_set_budget',
        arguments: { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 11_500_000 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: 'PLAN_LIMIT',
        _adport: { tool: 'mock_set_budget', view: 'operation' },
      });
      const { _adport, ...payload } = result.structuredContent as Record<string, unknown>;
      expect(payload).toEqual(textOf(result as never));
      expect(textOf(result as never)).toEqual({
        error: 'PLAN_LIMIT',
        code: 'PLAN_LIMIT',
        message: 'MCP write tools are not included in the current Free plan. They require operator or higher with write access. No changes were made.',
        planLimit: {
          kind: 'write_access',
          currentPlan: 'Free',
          recommendedPlan: 'operator',
          message: 'MCP write tools are not included in the current Free plan. They require operator or higher with write access. No changes were made.',
        },
      });

      expect(JSON.stringify(result)).not.toMatch(/upgradeUrl|checkout|dashboard\/billing|Upgrade to/);
      const campaigns = textOf(
        (await scopedClient.callTool({ name: 'mock_list_campaigns', arguments: { account_id: 'mock-1' } })) as never,
      ) as { campaigns: Array<{ id: string; dailyBudgetMicros: number }> };
      expect(campaigns.campaigns.find((campaign) => campaign.id === 'c1')?.dailyBudgetMicros).toBe(10_000_000);
    } finally {
      await scopedClient.close();
    }
  });
});

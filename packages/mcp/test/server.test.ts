import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/index.js';

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
    const applyFinding = tools.find((t) => t.name === 'recommendation_apply');
    expect(applyFinding?.annotations?.openWorldHint).toBe(true);
  });

  it('answers accounts_list', async () => {
    const result = await client.callTool({ name: 'accounts_list', arguments: {} });
    const parsed = textOf(result as never) as { accounts: Array<{ id: string }> };
    expect(parsed.accounts.map((a) => a.id)).toEqual(['mock-1', 'mock-2']);
  });

  it('enforces the two-step write over MCP (M0 exit criterion)', async () => {
    const args = { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 11_500_000 };

    const first = textOf(
      (await client.callTool({ name: 'mock_set_budget', arguments: args })) as never,
    ) as { status: string; pending_operation_id: string; preview: { budgetDeltas: unknown[] } };
    expect(first.status).toBe('pending_validation');
    expect(first.preview.budgetDeltas).toHaveLength(1);

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
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    const parsed = textOf(result as never) as { error: string };
    expect(parsed.error).toBe('POLICY_VIOLATION');
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
});

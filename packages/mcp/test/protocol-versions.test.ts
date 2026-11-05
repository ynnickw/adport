import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '@adport/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import { createMcpServer, createMcpUiServer } from '../src/index.js';
import { ADPORT_UI_URI } from '../src/ui.js';

describe('official MCP HTTP protocol entries', () => {
  it('serves the UI resource without a runtime or any callable business tools', async () => {
    const handler = createMcpHandler(() => createMcpUiServer({ uiDomain: 'fixture.claudemcpcontent.com' }));
    const client = new Client({ name: 'ui-only-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://adport.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
      const resource = (await client.readResource({ uri: ADPORT_UI_URI })).contents[0]!;
      expect(resource).toMatchObject({ mimeType: 'text/html;profile=mcp-app', _meta: { ui: { domain: 'fixture.claudemcpcontent.com' } } });
      expect(resource._meta).not.toHaveProperty('openai/widgetDomain');
      await expect(client.callTool({ name: 'mock_set_campaign_status', arguments: { account_id: 'mock-1', campaign_id: 'c1', status: 'PAUSED' } })).rejects.toThrow();
    } finally { await client.close(); await handler.close(); }
  });

  it.each(['modern', 'legacy'] as const)('serves %s static resources separately without disrupting guarded registry writes', async era => {
    const home = await mkdtemp(join(tmpdir(), 'adport-protocol-test-'));
    const previousHome = process.env.ADPORT_HOME;
    process.env.ADPORT_HOME = home;
    const runtime = await createContext({ includeMock: true });
    const handler = createMcpHandler(() => createMcpServer({ runtime }));
    const uiHandler = createMcpHandler(() => createMcpUiServer());
    const wire: Array<{ method: unknown; protocol: string | null }> = [];
    const client = new Client({ name: 'protocol-test', version: '1' }, era === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StreamableHTTPClientTransport(new URL('https://adport.test/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        let uiOnly = false;
        if (request.method === 'POST') {
          const body = await request.clone().json() as { method?: unknown };
          wire.push({ method: body.method, protocol: request.headers.get('mcp-protocol-version') });
          uiOnly = ['resources/read', 'resources/list', 'resources/templates/list'].includes(String(body.method));
        }
        return (uiOnly ? uiHandler : handler).fetch(request);
      },
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe(era);
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name).sort()).toEqual(runtime.registry.list().map(tool => tool.name).sort());
      const write = tools.find(tool => tool.name === 'mock_set_campaign_status')!;
      expect(write._meta).toMatchObject({ ui: { resourceUri: ADPORT_UI_URI } });
      const resource = await client.readResource({ uri: ADPORT_UI_URI });
      expect(resource.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app' });
      expect(resource.contents[0]).toHaveProperty('text');
      expect((await client.listResources()).resources.map(value => value.uri)).toEqual([ADPORT_UI_URI, 'ui://adport/insight-card-v21.html', 'ui://adport/insight-card-v20.html', 'ui://adport/insight-card-v19.html', 'ui://adport/insight-card-v18.html', 'ui://adport/insight-card-v17.html', 'ui://adport/insight-card-v16.html', 'ui://adport/insight-card-v15.html', 'ui://adport/insight-card-v14.html', 'ui://adport/insight-card-v13.html', 'ui://adport/insight-card-v12.html', 'ui://adport/insight-card-v11.html', 'ui://adport/insight-card-v10.html', 'ui://adport/insight-card-v9.html', 'ui://adport/insight-card-v8.html', 'ui://adport/insight-card-v7.html', 'ui://adport/insight-card-v6.html', 'ui://adport/insight-card-v5.html', 'ui://adport/insight-card-v4.html', 'ui://adport/insight-card-v3.html', 'ui://adport/insight-card-v2.html']);
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
      const input = { account_id: 'mock-1', campaign_id: 'c1', status: 'PAUSED' };
      const preview = await client.callTool({ name: 'mock_set_campaign_status', arguments: input });
      expect(preview.isError).not.toBe(true);
      const data = preview.structuredContent as { pending_operation_id: string; applied: boolean; _adport: { approval: { arguments: unknown } } };
      expect(data.applied).toBe(false);
      expect(data._adport.approval.arguments).toEqual(input);
      const mismatch = await client.callTool({ name: 'mock_set_campaign_status', arguments: { ...input, status: 'ENABLED', pending_operation_id: data.pending_operation_id } });
      expect(mismatch.isError).toBe(true);
      const applied = await client.callTool({ name: 'mock_set_campaign_status', arguments: { ...input, pending_operation_id: data.pending_operation_id } });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toHaveProperty('applied', true);
      expect(applied.structuredContent).not.toHaveProperty('_adport.approval');
      expect(wire.some(request => request.method === 'server/discover')).toBe(era === 'modern');
      expect(wire.some(request => request.method === 'initialize')).toBe(era === 'legacy');
      if (era === 'modern') expect(wire.every(request => request.protocol === '2026-07-28')).toBe(true);
    } finally {
      await client.close();
      await handler.close();
      await uiHandler.close();
      if (previousHome === undefined) delete process.env.ADPORT_HOME;
      else process.env.ADPORT_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps read-only grants read-only on the modern protocol', async () => {
    const runtime = await createContext({ includeMock: true });
    const handler = createMcpHandler(() => createMcpServer({ runtime, scopes: ['tools:read'] }));
    const client = new Client({ name: 'read-only-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://adport.test/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
      expect((await client.listTools()).tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true);
      await expect(client.callTool({ name: 'mock_set_campaign_status', arguments: { account_id: 'mock-1', campaign_id: 'c1', status: 'ENABLED' } })).rejects.toThrow(/not found/);
    } finally { await client.close(); await handler.close(); }
  });
});

describe('stdio protocol selection', () => {
  it.each(['modern', 'legacy'] as const)('serves a %s client through the built credential-free binary', async era => {
    const home = await mkdtemp(join(tmpdir(), 'adport-stdio-test-'));
    const client = new Client({ name: 'stdio-test', version: '1' }, era === 'modern'
      ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), '--demo'],
      env: { ADPORT_HOME: home },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe(era);
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('mock_set_campaign_status');
    } finally { await client.close(); await rm(home, { recursive: true, force: true }); }
  });
});

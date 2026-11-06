import { describe, expect, it } from 'vitest';
import { createContext, gtmTools } from '@adport/core';
import { GtmClient, GtmProvider } from '@adport/provider-gtm';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createMcpServer } from '../src/index.js';

describe('GTM hosted MCP surface', () => {
  it.each([['tools:read'], ['tools:read', 'tools:write']])('exposes the shared GTM tools with grant scopes %j', async (...scopes) => {
    const provider = new GtmProvider(new GtmClient({ clientId: 'test', clientSecret: 'test', refreshToken: 'test' },
      (() => { throw new Error('Unexpected provider request'); }) as typeof fetch));
    const runtime = await createContext({ providerModules: [{ provider, tools: gtmTools(provider) }] });
    const server = createMcpServer({ runtime, productionOnly: true, scopes });
    const client = new Client({ name: 'gtm-surface-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('gtm_'));
      expect(tools.some(tool => tool.name === 'gtm_get_installation_snippet')).toBe(true);
      expect(tools.some(tool => tool.name === 'gtm_publish_version')).toBe(scopes.includes('tools:write'));
      expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
      for (const tool of tools) {
        expect(tool.annotations?.openWorldHint).toBe(true);
        if (tool.annotations?.readOnlyHint) continue;
        expect(tool.annotations?.destructiveHint).toBe(true);
        expect(tool.inputSchema.properties).toHaveProperty('pending_operation_id');
      }
    } finally { await client.close(); await server.close(); }
  });
});

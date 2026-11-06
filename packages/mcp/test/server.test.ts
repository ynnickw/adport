import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AdportError, createContext, defineTool, FindingsStore, type ManagedMediaLibrary } from '@adport/core';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpServer, createMcpUiServer } from '../src/index.js';
import { ADPORT_UI_DOMAIN, ADPORT_UI_HTML, ADPORT_UI_URI, ADPORT_UI_RESOURCE_DOMAINS } from '../src/ui.js';

let home: string;
let client: Client;

it('rejects demo runtimes before advertising tools on the production connector', async () => {
  const runtime = await createContext({ includeMock: true });
  expect(() => createMcpServer({ runtime, productionOnly: true })).toThrow(/not available on the production connector/);
});

it('rejects synthetic provenance even without demo-named tools in production', async () => {
  const runtime = await createContext({ providerModules: [] });
  runtime.dataSource = 'synthetic';
  expect(() => createMcpServer({ runtime, productionOnly: true })).toThrow(/not available on the production connector/);
});

it('allows an empty real runtime without substituting demos in production', async () => {
  const runtime = await createContext({ providerModules: [] });
  const server = createMcpServer({ runtime, productionOnly: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const productionClient = new Client({ name: 'production-test', version: '1' });
  await server.connect(serverTransport);
  await productionClient.connect(clientTransport);
  try {
    expect((await productionClient.listTools()).tools.every(tool => !/^(demo|mock|synthetic)_/.test(tool.name))).toBe(true);
    await expect(productionClient.callTool({ name: 'demo_set_budget', arguments: {} })).rejects.toThrow(/not found/);
  } finally { await productionClient.close(); await server.close(); }
});

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
  it('keeps sensitive read arguments out of refresh/continuation metadata while preserving ordinary paging', async () => {
    const runtime = await createContext({ providerModules: [] });runtime.registry.register(defineTool({ name: 'private_records', namespace: 'core', description: 'Synthetic private read', annotations: { readOnly: true }, presentation: 'records', pagination: { cursorInput: 'cursor' }, sensitiveInputs: ['source'], input: z.object({ source: z.string().optional(), cursor: z.string().optional() }), output: z.object({ records: z.array(z.object({ id: z.string() })), next_cursor: z.string() }), handler: async () => ({ records: [{ id: 'safe' }], next_cursor: 'next' }) }));
    const server = createMcpServer({ runtime }), host = new Client({ name: 'private-read-metadata-test', version: '1' }), [ct, st] = InMemoryTransport.createLinkedPair();await server.connect(st);await host.connect(ct);
    try {
      const privateResult = await host.callTool({ name: 'private_records', arguments: { source: 'https://source.example.test/private?secret=PRIVATE' } });expect(privateResult.isError).not.toBe(true);expect(JSON.stringify(privateResult)).not.toContain('PRIVATE');expect(privateResult.structuredContent).toMatchObject({ records: [{ id: 'safe' }] });expect(privateResult.structuredContent).not.toHaveProperty('_adport.refresh');expect(privateResult.structuredContent).not.toHaveProperty('_adport.next');
      const ordinary = await host.callTool({ name: 'private_records', arguments: {} });expect(ordinary.structuredContent).toMatchObject({ _adport: { refresh: { arguments: {} }, next: { arguments: { cursor: 'next' } } } });
    } finally { await host.close();await server.close(); }
  });
  it('exports complete native file parameter schemas on read and guarded write tools', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['media_inspect_file', 'media_import_file']) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool._meta?.['openai/fileParams']).toEqual(['file']);
      const schema = (tool.inputSchema.properties as Record<string, any>).file;
      expect(Object.keys(schema.properties).sort()).toEqual(['download_url', 'file_id', 'file_name', 'mime_type']);
      expect(schema.required.sort()).toEqual(['download_url', 'file_id']);
      expect(schema.additionalProperties).toBe(false);
    }
    const imported = tools.find(tool => tool.name === 'media_import_file')!;
    expect(imported.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(imported._meta).toHaveProperty('ui');
  });
  it('includes the display title in annotations for directory clients', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.title?.trim().length).toBeGreaterThan(0);
      expect(tool.annotations?.title).toBe(tool.title);
    }
  });
  it('binds widget approval to the exact validated write and keeps the normal policy gate', async () => {
    const input = { account_id: 'mock-1', campaign_id: 'c1', status: 'PAUSED' };
    const first = await client.callTool({ name: 'mock_set_campaign_status', arguments: input });
    expect(first.isError).not.toBe(true);
    const payload = first.structuredContent as { pending_operation_id: string; _adport: { approval: { arguments: Record<string, unknown> } } };
    expect(payload._adport.approval.arguments).toEqual(input);
    const second = await client.callTool({ name: 'mock_set_campaign_status', arguments: { ...payload._adport.approval.arguments, pending_operation_id: payload.pending_operation_id } });
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toHaveProperty('applied', true);
    expect(second.structuredContent).not.toHaveProperty('_adport.approval');
  });
  it('uses the host sandbox domain without a conflicting OpenAI origin alias', async () => {
    const runtime = await createContext({ providerModules: [] });
    const uiDomain = '0123456789abcdef0123456789abcdef.claudemcpcontent.com';
    const uiConnectDomains = ['https://private-storage.example'];
    const server = createMcpServer({ runtime, uiDomain, uiConnectDomains });
    const hostClient = new Client({ name: 'host-domain-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await hostClient.connect(clientTransport);
    try {
      const listing = (await hostClient.listResources()).resources.find(resource => resource.uri === ADPORT_UI_URI);
      const content = (await hostClient.readResource({ uri: ADPORT_UI_URI })).contents[0];
      for (const resource of [listing, content]) {
        expect(resource?._meta).toMatchObject({
          ui: { domain: uiDomain, csp: { connectDomains: uiConnectDomains, resourceDomains: ADPORT_UI_RESOURCE_DOMAINS } },
        });
        expect(resource?._meta).not.toHaveProperty('openai/widgetDomain');
      }
    } finally { await hostClient.close(); await server.close(); }
  });

  it.each(['registry', 'static'] as const)('allows the %s server to omit an optional sandbox domain while retaining CSP and resource aliases', async kind => {
    const runtime = await createContext({ providerModules: [] });
    const options = { uiDomain: null, uiConnectDomains: ['https://private-storage.example'] };
    const server = kind === 'registry' ? createMcpServer({ runtime, ...options }) : createMcpUiServer(options);
    const host = new Client({ name: 'default-sandbox-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await host.connect(clientTransport);
    try {
      const listing = (await host.listResources()).resources.find(resource => resource.uri === ADPORT_UI_URI);
      for (const resource of [listing, (await host.readResource({ uri: ADPORT_UI_URI })).contents[0], (await host.readResource({ uri: 'ui://adport/insight-card-v10.html' })).contents[0]]) {
        expect(resource?._meta).toMatchObject({ ui: { prefersBorder: false, csp: { connectDomains: options.uiConnectDomains, resourceDomains: ADPORT_UI_RESOURCE_DOMAINS } } });
        expect(resource?._meta).not.toHaveProperty('ui.domain');
        expect(resource?._meta).not.toHaveProperty('openai/widgetDomain');
      }
    } finally { await host.close(); await server.close(); }
  });

  it('returns read-only creative refresh arguments and keeps upload checksums outside human copy', async () => {
    const runtime = await createContext({ providerModules: [], media: { read: async () => { throw new Error('No upload'); }, list: async () => ({ assets: [{ id: '11111111-1111-4111-8111-111111111111', name: 'QA.png', content_type: 'image/png', byte_length: 17095, sha256: 'a'.repeat(64), status: 'READY', width: 640, height: 640 }], truncated: true, next_cursor: '22222222-2222-4222-8222-222222222222' }) } });
    const server = createMcpServer({ runtime, scopes: ['tools:read'] }), host = new Client({ name: 'media-read-host', version: '1' }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport); await host.connect(clientTransport);
    try {
      const result = await host.callTool({ name: 'media_list', arguments: { limit: 10 } }); expect(result.isError).not.toBe(true); expect(result.structuredContent).toMatchObject({ assets: [{ sha256: 'a'.repeat(64), status: 'READY' }], creatives: [{ status: 'READY', descriptions: ['17 KB · 640 × 640'] }], _adport: { capabilities: { can_write: false }, refresh: { arguments: { limit: 10 } }, next: { arguments: { limit: 10, cursor: '22222222-2222-4222-8222-222222222222' } } } });
      expect(result.structuredContent).not.toHaveProperty('_adport.approval');
    } finally { await host.close(); await server.close(); }
  });

  it('renders a single media_get source through the real SDK result without adding upload or write controls', async () => {
    const asset = { id: '11111111-1111-4111-8111-111111111111', name: 'QA single.png', content_type: 'image/png', byte_length: 172, sha256: 'a'.repeat(64), status: 'READY' as const, width: 1200, height: 628, preview_url: 'https://storage.example/qa.png', metadata_version: 1 };
    const media: ManagedMediaLibrary = { scopeId: 'project-a', get: async () => asset, list: async () => { throw new Error('No list expected'); }, read: async () => { throw new Error('No byte read expected'); }, previewWrite: async () => { throw new Error('No write expected'); }, applyWrite: async () => { throw new Error('No write expected'); } };
    const runtime = await createContext({ providerModules: [], media });
    const server = createMcpServer({ runtime, scopes: ['tools:read'] }), host = new Client({ name: 'single-media-read-host', version: '1' }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await host.connect(clientTransport);
    const dom = new JSDOM(ADPORT_UI_HTML, { runScripts: 'dangerously', url: 'https://widget.example' });
    try {
      const result = await host.callTool({ name: 'media_get', arguments: { media_id: asset.id } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ asset, truncated: false, _adport: { tool: 'media_get', view: 'creatives', capabilities: { can_write: false } } });
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source: dom.window.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result } }));
      expect(dom.window.document.querySelector('img')?.getAttribute('src')).toBe(asset.preview_url);
      expect(dom.window.document.querySelector('.creative-name')?.textContent).toBe(asset.name);
      expect(dom.window.document.querySelector('main')?.textContent).toContain('172 bytes · 1200 × 628');
      expect(dom.window.document.querySelector('[data-upload-files], [data-library-more], .creative-action')).toBeNull();
      expect(dom.window.document.querySelector('main')?.textContent).not.toContain(asset.sha256);
    } finally { dom.window.close(); await host.close(); await server.close(); }
  });

  it('advertises meaningful shared output schemas for every common submission tool', async () => {
    const runtime = await createContext();
    const { tools } = await client.listTools();
    const names = ['accounts_list', 'report', 'audit_preview', 'audit_run', 'recommendations_list', 'recommendation_dismiss', 'recommendation_apply'];
    for (const name of names) {
      const schema = tools.find(tool => tool.name === name)?.outputSchema;
      expect(schema?.type).toBe('object');
      expect(schema?.required).toContain('_adport');
      const output = runtime.registry.get(name).output;
      expect(output).toBeInstanceOf(z.ZodObject);
      expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(Object.keys((output as z.ZodObject).shape)));
    }
    const report = tools.find(tool => tool.name === 'report')!.outputSchema!;
    expect(JSON.stringify(report)).toContain('conversion_value_over_spend');
    expect(JSON.stringify(report)).toContain('null');
    const apply = tools.find(tool => tool.name === 'recommendation_apply')!.outputSchema!;
    expect(JSON.stringify(apply)).toContain('pending_operation_id');
    expect(JSON.stringify(apply)).toContain('pending_validation');
  });

  it('validates all common success results through SDK output validation, including the recommendation lifecycle', async () => {
    const requests = [
      { name: 'accounts_list', arguments: {} },
      { name: 'report', arguments: { metrics: ['spend', 'clicks'] } },
      { name: 'audit_preview', arguments: {} },
      { name: 'audit_run', arguments: {} },
      { name: 'recommendations_list', arguments: {} },
    ];
    for (const request of requests) {
      const result = await client.callTool(request);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toHaveProperty('_adport.tool', request.name);
    }
    const audit = await client.callTool({ name: 'audit_run', arguments: {} });
    const findings = (audit.structuredContent as { findings: Array<{ id: string; proposedAction?: unknown }> }).findings;
    const actionable = findings.find(finding => finding.proposedAction);
    expect(actionable).toBeDefined();
    const first = await client.callTool({ name: 'recommendation_apply', arguments: { finding_id: actionable!.id } });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    const pending = (first.structuredContent as { result: { pending_operation_id: string } }).result;
    const second = await client.callTool({ name: 'recommendation_apply', arguments: { finding_id: actionable!.id, pending_operation_id: pending.pending_operation_id } });
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    expect(second.structuredContent).toHaveProperty('result.applied', true);
    const store = new FindingsStore();
    const other = { ...(await store.get(actionable!.id))!, id: 'dismiss-schema-fixture', status: 'open' as const };
    await store.save(other);
    const dismissed = await client.callTool({ name: 'recommendation_dismiss', arguments: { finding_id: other.id } });
    expect(dismissed.isError, JSON.stringify(dismissed)).not.toBe(true);
    expect(dismissed.structuredContent).toHaveProperty('finding.status', 'dismissed');
    expect((await new FindingsStore().get(actionable!.id))?.status).toBe('applied');
  });

  it('keeps empty results schema-valid and preserves tool errors without manufacturing success fields', async () => {
    const runtime = await createContext();
    const server = createMcpServer({ runtime, productionOnly: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const empty = new Client({ name: 'empty-reviewer', version: '1' });
    await Promise.all([server.connect(st), empty.connect(ct)]);
    try {
      await empty.listTools();
      const list = await empty.callTool({ name: 'recommendations_list', arguments: {} });
      expect(list.isError).not.toBe(true);
      expect(list.structuredContent).toMatchObject({ findings: [], count: 0 });
      const disconnected = await empty.callTool({ name: 'accounts_list', arguments: {} });
      expect(disconnected.isError).toBe(true);
      expect(disconnected.structuredContent).toBeUndefined();
      expect(textOf(disconnected as never)).toHaveProperty('error', 'NOT_CONNECTED');
    } finally { await empty.close(); await server.close(); }
  });

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
      await hosted.listTools();
      for (const request of [
        { name: 'accounts_list', arguments: {} },
        { name: 'accounts_list', arguments: { provider: 'demo' } },
        { name: 'report', arguments: { provider: 'google' } },
      ]) {
        const result = await hosted.callTool(request);
        expect(result.isError).toBe(true);
        const expected = { error: 'NOT_CONNECTED', message: notConnectedMessage };
        expect(textOf(result as never)).toEqual(expected);
        expect(result.structuredContent).toBeUndefined();
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

  it('marks synthetic responses in text and successful structured content', async () => {
    const runtime = await createContext({ includeMock: true });
    runtime.dataSource = 'synthetic';
    const server = createMcpServer({ runtime });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const reviewer = new Client({ name: 'synthetic-test', version: '1' });
    await Promise.all([server.connect(st), reviewer.connect(ct)]);
    try {
      for (const args of [{}, { provider: 'not-connected' }]) {
        const result = await reviewer.callTool({ name: 'accounts_list', arguments: args });
        if (result.isError) expect(result.structuredContent).toBeUndefined();
        else expect(result.structuredContent).toMatchObject({ data_source: 'synthetic' });
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
    expect(list?.annotations?.openWorldHint).toBe(false);
    const persistedFindings = tools.find((t) => t.name === 'recommendations_list');
    expect(persistedFindings?.annotations?.openWorldHint).toBe(false);
    const previewAudit = tools.find((t) => t.name === 'audit_preview');
    expect(previewAudit?.annotations?.readOnlyHint).toBe(true);
    expect(previewAudit?.annotations?.openWorldHint).toBe(false);
    const persistedAudit = tools.find((t) => t.name === 'audit_run');
    expect(persistedAudit?.annotations?.readOnlyHint).toBe(false);
    expect(persistedAudit?.annotations?.openWorldHint).toBe(false);
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
    expect(content.text).toContain('<b>adport<span class="wordmark-dot" aria-hidden="true">.</span></b>');
    expect(content.text).not.toContain('evidence before action');
    expect(content.text).not.toMatch(/https?:\/\//);
    const script = content.text?.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(content._meta).toEqual({
      ui: {
        domain: ADPORT_UI_DOMAIN,
        prefersBorder: false,
        csp: { connectDomains: [], resourceDomains: ADPORT_UI_RESOURCE_DOMAINS },
      },
      'openai/widgetDomain': ADPORT_UI_DOMAIN,
    });
    const previous = await client.readResource({ uri: 'ui://adport/insight-card-v2.html' });
    expect(previous.contents[0]).toMatchObject({ uri: 'ui://adport/insight-card-v2.html', mimeType: content.mimeType, text: content.text });
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
    const descriptor = (await client.listTools()).tools.find(tool => tool.name === 'mock_set_budget')!;
    expect(descriptor._meta).toMatchObject({
      'openai/toolInvocation/invoking': 'Processing change…',
      'openai/toolInvocation/invoked': 'Change result ready',
    });

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
    expect((await client.listTools()).tools.find(tool => tool.name === 'mock_set_budget')?._meta).toEqual(descriptor._meta);

    const campaigns = textOf(
      (await client.callTool({ name: 'mock_list_campaigns', arguments: { account_id: 'mock-1' } })) as never,
    ) as { campaigns: Array<{ id: string; dailyBudgetMicros: number }> };
    expect(campaigns.campaigns.find((c) => c.id === 'c1')?.dailyBudgetMicros).toBe(11_500_000);
  });

  it('surfaces policy violations as tool errors', async () => {
    await client.listTools();
    const result = (await client.callTool({
      name: 'mock_set_budget',
      arguments: { account_id: 'mock-1', campaign_id: 'c1', daily_budget_micros: 99_000_000 },
    }));
    expect(result.isError).toBe(true);
    const parsed = textOf(result as never) as { error: string };
    expect(parsed.error).toBe('POLICY_VIOLATION');
    expect(result.structuredContent).toBeUndefined();
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
      await errorClient.listTools();
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
        expect(result.structuredContent).toBeUndefined();
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
      expect(result.structuredContent).toBeUndefined();
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

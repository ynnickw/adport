import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CredentialStore } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assembleRuntime, createMcpServer } from '../src/index.js';

/**
 * Full-stack E2E: credential store → assembleRuntime → MCP server → MCP client,
 * with fetch mocked to return doc-faithful Meta Marketing API responses
 * (graph.facebook.com v25.0 shapes, verified against the live reference docs).
 */

let home: string;
let client: Client;
let graphCalls: Array<{ url: string; body: string }>;
let readResponse: unknown;

function textOf(result: { content?: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
}

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-meta-e2e-'));
  process.env.ADPORT_HOME = home;
  delete process.env.ADPORT_DEMO;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GOOGLE_ADS_') || key.startsWith('META_')) delete process.env[key];
  }
  await new CredentialStore().set({
    provider: 'meta',
    source: 'byo',
    data: { access_token: 'EAAJB-system-user-token' },
  });

  graphCalls = [];
  readResponse = { data: [{ id: '23851234567890123', name: 'August Sale', status: 'PAUSED' }] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const body = String(init?.body ?? '');
      graphCalls.push({ url: urlStr, body });
      if (!urlStr.includes('graph.facebook.com')) {
        throw new Error(`E2E test tried to reach a non-Graph host: ${urlStr}`);
      }
      if (urlStr.includes('/me/accounts')) {
        return Response.json({ data: [{ id: '123', name: 'Test Page', tasks: ['ANALYZE'], access_token: 'must-not-return' }] });
      }
      if (new URL(urlStr).pathname.endsWith('/123/posts')) {
        return Response.json({ data: [{ id: '123_1', message: 'Hello', likes: { summary: { total_count: 2 } } }] });
      }
      if (new URL(urlStr).pathname.endsWith('/123')) {
        return Response.json({ id: '123', name: 'Test Page', fan_count: 5 });
      }
      if (urlStr.includes('/insights') || (urlStr.includes('/campaigns') && !body)) {
        return Response.json(readResponse);
      }
      if (urlStr.includes('/me/adaccounts')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'act_426197654150180',
                account_id: '426197654150180',
                name: 'Acme Meta',
                currency: 'EUR',
                account_status: 1,
              },
            ],
            paging: { cursors: { before: 'MAZDZD', after: 'MAZDZD' } },
          }),
        );
      }
      if (urlStr.includes('/campaigns')) {
        // validate_only → {"success": true}; real create → {"id": "..."}
        return new Response(
          body.includes('validate_only')
            ? JSON.stringify({ success: true })
            : JSON.stringify({ id: '23851234567890123' }),
        );
      }
      throw new Error(`Unmatched Graph call: ${urlStr}`);
    }),
  );

  const runtime = await assembleRuntime();
  const server = createMcpServer({ runtime });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllGlobals();
  delete process.env.ADPORT_HOME;
  delete process.env.ADPORT_DEMO;
  rmSync(home, { recursive: true, force: true });
});

describe('Meta E2E over MCP with doc-faithful Graph mocks', () => {
  it('keeps explicit demo mode isolated from stored real credentials', async () => {
    const runtime = await assembleRuntime({ includeMock: true });
    const names = runtime.registry.list().map((tool) => tool.name);
    expect(names).toContain('mock_list_campaigns');
    expect(names.some((name) => name.startsWith('meta_'))).toBe(false);
  });

  it('supports isolated demo mode through ADPORT_DEMO', async () => {
    process.env.ADPORT_DEMO = 'true';
    const runtime = await assembleRuntime();
    const names = runtime.registry.list().map((tool) => tool.name);
    expect(names).toContain('mock_list_campaigns');
    expect(names.some((name) => name.startsWith('meta_'))).toBe(false);
  });

  it('assembles the meta provider from stored credentials (no mock provider)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('meta_insights');
    expect(names).toContain('meta_create_campaign');
    expect(names.some((n) => n.startsWith('mock_'))).toBe(false);
    expect(names.some((n) => n.startsWith('google_'))).toBe(false);
    const meta = tools.filter(tool => tool.name.startsWith('meta_'));
    expect(meta).toHaveLength(13);
    for (const tool of meta) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
      expect(Object.keys(tool.outputSchema?.properties ?? {}).length).toBeGreaterThan(0);
      if (!tool.annotations?.readOnlyHint) {
        expect(tool.outputSchema?.required).toEqual(expect.arrayContaining(['status', 'applied', 'preview']));
      }
    }
  });

  it.each([
    { paged: true, response: { data: [{ id: '1', nested: { arbitrary: true } }] }, raw: [{ id: '1', nested: { arbitrary: true } }] },
    { paged: true, response: { data: [] }, raw: [] },
    { paged: false, response: { id: '1', nested: { arbitrary: true } }, raw: { id: '1', nested: { arbitrary: true } } },
  ])('preserves legacy API read text and supplies a schema-valid object envelope ($paged)', async ({ paged, response, raw }) => {
    await client.listTools();
    readResponse = response;
    const result = await client.callTool({ name: 'meta_api_read', arguments: { account_id: '426197654150180', edge: 'campaigns', paged } });
    expect(result.isError).not.toBe(true);
    expect(textOf(result as never)).toEqual(raw);
    expect(result.structuredContent).toEqual({ value: raw });
  });

  it('validates Page outputs and excludes Page access tokens', async () => {
    await client.listTools();
    const pages = await client.callTool({ name: 'meta_list_pages', arguments: {} });
    expect(pages.isError).not.toBe(true);
    expect(pages.structuredContent).toEqual({ pages: [{ id: '123', name: 'Test Page', tasks: ['ANALYZE'] }], page_count: 1 });
    expect(JSON.stringify(pages)).not.toContain('must-not-return');
    const engagement = await client.callTool({ name: 'meta_page_engagement', arguments: { page_id: '123' } });
    expect(engagement.isError).not.toBe(true);
    expect(engagement.structuredContent).toMatchObject({ page: { id: '123', fan_count: 5 }, posts: [{ id: '123_1', shares: 0, likes: 2, comments: 0 }] });
    const denied = await client.callTool({ name: 'meta_page_engagement', arguments: { page_id: '999' } });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    expect(textOf(denied as never)).toHaveProperty('error', 'INVALID_INPUT');
  });

  it.each([{ rows: [] }, { rows: [{ campaign_id: '1', spend: '1.25', impressions: '42', actions: [{ action_type: 'purchase', value: '2' }], reach: '30' }] }])('validates empty and populated insights without converting metrics or discarding fields', async ({ rows }) => {
    await client.listTools();
    readResponse = { data: rows };
    const result = await client.callTool({ name: 'meta_insights', arguments: { account_id: '426197654150180' } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ rows, row_count: rows.length });
    expect(textOf(result as never)).toEqual(result.structuredContent);
  });

  it('lists Meta ad accounts through the MCP tool', async () => {
    const result = textOf((await client.callTool({ name: 'accounts_list', arguments: {} })) as never) as {
      accounts: Array<{ provider: string; id: string; status?: string }>;
    };
    expect(result.accounts).toEqual([
      { provider: 'meta', id: '426197654150180', name: 'Acme Meta', currency: 'EUR', status: 'ACTIVE' },
    ]);
  });

  it('rejects malformed successful provider output rather than advertising it as valid', async () => {
    await client.listTools();
    readResponse = { data: [{ spend: 1.25 }] }; // Graph metrics must be strings.
    const result = await client.callTool({ name: 'meta_insights', arguments: { account_id: '426197654150180' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it('runs the full two-step campaign creation: validate_only dry run, then apply', async () => {
    await client.listTools(); // Enable SDK validation for both preview and apply.
    const args = {
      account_id: '426197654150180',
      name: 'August Sale',
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
    };

    const first = textOf(
      (await client.callTool({ name: 'meta_create_campaign', arguments: args })) as never,
    ) as {
      status: string;
      pending_operation_id: string;
      preview: { serverValidated: boolean; coercions: string[] };
    };
    expect(first.status).toBe('pending_validation');
    expect(first.preview.serverValidated).toBe(true);
    expect(first.preview.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);

    const validateCall = graphCalls.find((c) => c.url.includes('/campaigns'));
    expect(validateCall?.url).toContain('/v25.0/act_426197654150180/campaigns');
    const validateBody = new URLSearchParams(validateCall!.body);
    expect(validateBody.get('execution_options')).toBe('["validate_only"]');
    expect(validateBody.get('special_ad_categories')).toBe('[]');
    expect(validateBody.get('status')).toBe('PAUSED');

    const second = textOf(
      (await client.callTool({
        name: 'meta_create_campaign',
        arguments: { ...args, pending_operation_id: first.pending_operation_id },
      })) as never,
    ) as { status: string; result: { resourceIds: string[] } };
    expect(second.status).toBe('applied');
    expect(second.result.resourceIds).toEqual(['23851234567890123']);

    const applyCall = graphCalls.filter((c) => c.url.includes('/campaigns')).at(-1)!;
    expect(new URLSearchParams(applyCall.body).get('execution_options')).toBeNull();
  });
});

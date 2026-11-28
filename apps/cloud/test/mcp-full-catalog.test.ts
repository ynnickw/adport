import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_POLICY, type ToolSelection } from '@adport/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import { POST } from '@/app/mcp/route';
import { resetEnvForTests } from '@/lib/env';
import { CLOUD_PROVIDERS } from '@/lib/cloud/types';
import { createTenantRuntime, hostedToolCatalogCounts } from '@/lib/cloud/runtime';
import { catalogToolCount } from '@/lib/mcp-tool-selection';
import mcpPackage from '../../../packages/mcp/package.json';

const projectId = '11111111-1111-4111-8111-111111111111';
const oauth = vi.hoisted(() => ({ client: vi.fn() }));
const catalog = vi.hoisted(() => ({ selection: vi.fn() }));

vi.mock('@/lib/cloud/auth', () => ({ apiPrincipal: async () => ({
  organizationId: projectId,
  userId: 'test-user',
  oauthTokenId: 'test-token',
  clientId: 'test-client',
  scopes: ['tools:read', 'tools:write'],
}) }));
vi.mock('@/lib/cloud/mcp-oauth-repository', () => ({ getMcpOAuthClient: oauth.client }));
vi.mock('@/lib/cloud/tool-catalog', () => ({ principalToolSelection: catalog.selection }));
vi.mock('@/lib/cloud/repository', () => ({
  getOrganizationPolicy: async () => DEFAULT_POLICY,
  listOrganizationAdAccounts: async () => [],
  loadEnabledAccountIds: async () => ({}),
  loadProviderCredentials: async () => ({}),
  PostgresAuditStore: class {},
  PostgresPendingStore: class {},
  PostgresFindingsStore: class {},
}));

async function listCatalog(selection: ToolSelection, modern: boolean, inspectResources = false) {
  catalog.selection.mockResolvedValue(selection);
  oauth.client.mockResolvedValue({ redirectUris: [
    modern ? 'https://chatgpt.com/connector/oauth/test' : 'https://claude.ai/api/mcp/auth_callback',
  ] });
  const client = new Client({ name: 'catalog-size-test', version: '1' }, modern
    ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  const responseSizes: number[] = [];
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('https://app.adport.test/mcp'), {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        const body = request.method === 'POST' ? await request.clone().json() as { method?: string } : undefined;
        const response = await POST(request);
        if (body?.method === 'tools/list') responseSizes.push((await response.clone().arrayBuffer()).byteLength);
        return response;
      },
    }));
    const result = await client.listTools();
    expect(result.nextCursor).toBeUndefined();
    expect(responseSizes).toHaveLength(1);
    const capabilities = result.tools.find(tool => tool.name === 'capabilities_list')!;
    expect(capabilities.inputSchema.properties?.provider).toMatchObject({ enum: [...CLOUD_PROVIDERS] });
    const resources = inspectResources ? (await client.listResources()).resources : [];
    const resourcesByUri = new Map(resources.map(resource => [resource.uri, resource]));
    return { tools: result.tools, wireBytes: responseSizes[0]!, instructions: client.getInstructions(), resourcesByUri, serverVersion: client.getServerVersion()?.version };
  } finally { await client.close(); }
}

it('returns only platforms supported by the hosted runtime in capability discovery', async () => {
  const runtime = await createTenantRuntime({ organizationId: projectId, scopes: ['tools:read'] }, { surface: 'mcp' });
  const result = await runtime.registry.call('capabilities_list', { limit: 1 }, runtime.ctx);
  expect(result).toMatchObject({ platforms: CLOUD_PROVIDERS.map(id => ({ id })) });
});

it('counts the advertised Standard catalog and keeps the native campaign tools in Full', async () => {
  const providers = ['google', 'meta', 'linkedin'] as const;
  const catalog = hostedToolCatalogCounts([projectId]);
  const scopes = ['tools:read', 'tools:write'];
  const standard = { profile: 'standard', providers } as const;
  const full = { profile: 'full', providers } as const;
  const standardResult = await listCatalog(standard, false);
  const fullResult = await listCatalog(full, false);
  const names = standardResult.tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['campaigns_list', 'campaign_set_status', 'google_gaql', 'linkedin_set_campaign_status']));
  expect(names).not.toContain('meta_list_campaigns');
  expect(names).not.toContain('meta_set_campaign_status');
  expect(standardResult.tools.find(tool => tool.name === 'campaign_set_status')?.inputSchema.properties?.provider).toEqual({
    type: 'string', enum: expect.arrayContaining([...providers]),
  });
  expect(fullResult.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['meta_list_campaigns', 'meta_set_campaign_status']));
  expect(catalogToolCount(catalog, standard, scopes, true)).toBe(standardResult.tools.length);
  expect(catalogToolCount(catalog, full, scopes, true)).toBe(fullResult.tools.length);
});

it('keeps the full hosted tools/list response within its wire budget on both transports', async () => {
  vi.stubEnv('GA4_OAUTH_ENABLED', 'true');
  resetEnvForTests();
  const providerFetch = vi.fn(() => { throw new Error('Catalog discovery must not call providers'); });
  vi.stubGlobal('fetch', providerFetch);
  try {
    const selection = { profile: 'full', providers: null } as const;
    const modern = await listCatalog(selection, true);
    const legacy = await listCatalog(selection, false);
    for (const [transport, result] of Object.entries({ modern, legacy })) {
      expect(result.serverVersion).toBe(mcpPackage.version);
      expect(result.wireBytes).toBeLessThan(2_850_000);
      const names = result.tools.map(tool => tool.name);
      for (const tool of result.tools) expect(tool.annotations?.title).toEqual(expect.any(String));
      expect(new Set(names).size).toBe(names.length);
      for (const [prefix, count] of [['analytics', 2], ['ga4', 0], ['gsc', 4], ['gtm', 24], ['matomo', 0], ['gravity', 16]] as const) {
        expect(names.filter(name => name.startsWith(prefix + '_'))).toHaveLength(count);
      }
      expect(names).toContain('projects_list');
      for (const name of ['media_inspect_file', 'media_import_file']) {
        const definition = result.tools.find(tool => tool.name === name)!;
        expect(definition._meta?.['openai/fileParams']).toEqual(['file']);
        expect(definition.inputSchema).toMatchObject({ properties: { file: { type: 'object', required: expect.arrayContaining(['download_url', 'file_id']) }, project_id: { type: 'string' } } });
      }
      expect(result.tools.find(tool => tool.name === 'media_import_file')?.inputSchema).toMatchObject({ properties: { content_type: { enum: expect.arrayContaining(['text/csv']) } } });
      expect(result.tools.find(tool => tool.name === 'media_upload')?.inputSchema).toMatchObject({ properties: { content_type: { enum: expect.arrayContaining(['text/csv']) } } });
      expect(result.tools.find(tool => tool.name === 'media_inspect_file')?.outputSchema).toMatchObject({ properties: { metadata: { properties: { content_type: { enum: expect.arrayContaining(['text/csv']) } } } } });
      expect(names.length).toBeGreaterThanOrEqual(871);
      expect(result.tools.find(tool => tool.name === 'google_set_budget')?.outputSchema).toMatchObject({
        required: expect.arrayContaining(['status', 'applied', 'preview', '_adport']),
        properties: {
          preview: { type: 'object', properties: { summary: { type: 'string' } }, additionalProperties: {} },
          _adport: { type: 'object', additionalProperties: {} },
        },
      });
      console.info(`Hosted catalog ${transport}: ${names.length} tools, ${result.wireBytes} bytes`);
    }
    expect(modern.tools).toEqual(legacy.tools);
    const outputDir = process.env.ADPORT_TOOL_BENCHMARK_CATALOGS;
    if (outputDir) {
      await mkdir(outputDir, { recursive: true });
      const exports = {
        full: legacy,
        standard: await listCatalog({ profile: 'standard', providers: null }, false),
        'standard-google-meta': await listCatalog({ profile: 'standard', providers: ['google', 'meta'] }, false),
      };
      for (const [name, result] of Object.entries(exports)) {
        await writeFile(join(outputDir, `${name}.json`), JSON.stringify(result));
        console.info(`Benchmark catalog ${name}: ${result.tools.length} tools, ${result.wireBytes} bytes`);
      }
    }
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvForTests();
  }
}, 60_000);

it('keeps the expanded publisher catalog below the metadata limit with GTM and Search Console available', async () => {
  vi.stubEnv('GA4_OAUTH_ENABLED', 'false');
  vi.stubEnv('ANALYTICS_TEST_ORGANIZATION_IDS', '');
  resetEnvForTests();
  try {
    const { tools, resourcesByUri } = await listCatalog({ profile: 'full', providers: null }, true, true);
    const names = tools.map(tool => tool.name);
    const toolsByName = new Map(tools.map(tool => [tool.name, tool]));
    expect(new Set(names).size).toBeGreaterThanOrEqual(861);
    expect(names.filter(name => name.startsWith('gtm_'))).toHaveLength(24);
    expect(names.filter(name => name.startsWith('gsc_'))).toHaveLength(4);
    expect(names.some(name => name.startsWith('ga4_'))).toBe(false);
    expect(names.filter(name => name.startsWith('matomo_'))).toHaveLength(0);
    expect(names.filter(name => name.startsWith('analytics_')).sort()).toEqual(['analytics_acquisition_report', 'analytics_goals']);
    expect(names.filter(name => name.startsWith('gravity_'))).toHaveLength(16);
    for (const name of ['spotify_update_pixel', 'spotify_update_capi_integration', 'spotify_update_dataset', 'spotify_update_mobile_app']) {
      expect(toolsByName.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const name of ['meta_create_campaign', 'google_create_performance_max_campaign', 'linkedin_get_sponsored_post']) {
      expect(toolsByName.get(name)?._meta?.ui, name).toMatchObject({ visibility: ['model', 'app'] });
    }
    expect(toolsByName.get('meta_create_campaign')?.title).toBe('Meta Create Campaign');
    expect(toolsByName.get('google_create_performance_max_campaign')?.title).toBe('Google Create Performance Max Campaign');
    expect(toolsByName.get('projects_list')?.title).toBeUndefined();
    expect(toolsByName.get('projects_list')?._meta?.ui).not.toHaveProperty('visibility');
    const summaryUri = String(tools.find(tool => tool.name === 'projects_list')?._meta?.['openai/outputTemplate']);
    const mediaUri = String(tools.find(tool => tool.name === 'media_list')?._meta?.['openai/outputTemplate']);
    expect(summaryUri).not.toBe(mediaUri);
    expect(resourcesByUri.get(summaryUri)?._meta).toMatchObject({
      ui: { csp: { connectDomains: [], resourceDomains: ['https://app.adport.dev', 'https://example.supabase.co'] } },
    });
    expect(resourcesByUri.get(mediaUri)?._meta).toMatchObject({
      ui: { csp: { connectDomains: ['https://example.supabase.co'], resourceDomains: expect.arrayContaining(['https://tpc.googlesyndication.com']) } },
    });

    // The publisher expands the referenced template into each tool definition.
    // Leave a per-tool allowance for its generated fields and serialization.
    const bytes = tools.reduce((total, tool) => {
      const uri = String(tool._meta?.['openai/outputTemplate']);
      const resource = resourcesByUri.get(uri);
      expect(resource).toBeDefined();
      const definition = {
        name: tool.name,
        title: tool.title,
        action_name: tool.name,
        description: tool.description,
        input_json_schema: tool.inputSchema,
        output_json_schema: tool.outputSchema,
        provided_tool_annotations: tool.annotations,
        metadata: tool._meta,
        templates: [{
          resource_uri: uri,
          meta: { ...resource?._meta, 'openai/widgetDescription': resource?.description },
        }],
      };
      return total + Buffer.byteLength(JSON.stringify(definition)) + 360;
    }, 0);
    console.info(`Estimated publisher metadata with GTM and Search Console available: ${names.length} tools, ${bytes} bytes`);
    expect(bytes).toBeLessThan(2_950_000);
  } finally {
    vi.unstubAllEnvs();
    resetEnvForTests();
  }
}, 60_000);

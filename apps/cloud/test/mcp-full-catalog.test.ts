import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_POLICY, type ToolSelection } from '@adport/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';
import { POST } from '@/app/mcp/route';
import { resetEnvForTests } from '@/lib/env';

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

async function listCatalog(selection: ToolSelection, modern: boolean) {
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
    return { tools: result.tools, wireBytes: responseSizes[0]!, instructions: client.getInstructions() };
  } finally { await client.close(); }
}

it('serves the full hosted catalog below the Claude reviewer limit on both transports', async () => {
  for (const key of ['GA4_OAUTH_ENABLED', 'GSC_OAUTH_ENABLED', 'GTM_OAUTH_ENABLED']) vi.stubEnv(key, 'true');
  resetEnvForTests();
  const providerFetch = vi.fn(() => { throw new Error('Catalog discovery must not call providers'); });
  vi.stubGlobal('fetch', providerFetch);
  try {
    const selection = { profile: 'full', providers: null } as const;
    const modern = await listCatalog(selection, true);
    const legacy = await listCatalog(selection, false);
    for (const [transport, result] of Object.entries({ modern, legacy })) {
      // Anthropic limits the wire answer to 4 MiB. Leave room for small catalog changes.
      expect(result.wireBytes).toBeLessThan(4 * 1024 * 1024 - 64 * 1024);
      const names = result.tools.map(tool => tool.name);
      expect(new Set(names).size).toBe(names.length);
      for (const [prefix, count] of [['ga4', 4], ['gsc', 4], ['gtm', 24]] as const) {
        expect(names.filter(name => name.startsWith(prefix + '_'))).toHaveLength(count);
      }
      expect(names).toContain('projects_list');
      expect(names.length).toBeGreaterThanOrEqual(871);
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

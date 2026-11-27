import { createContext, selectRuntimeCatalog, withProjectRouting } from '@adport/core';
import { AppleAdsClient, AppleAdsProvider, appleTools } from '@adport/provider-apple';
import { GoogleAdsProvider, GoogleAdsRestClient, googleTools } from '@adport/provider-google';
import { MetaAdsProvider, MetaGraphClient, metaTools } from '@adport/provider-meta';
import { MicrosoftAdsClient, MicrosoftAdsProvider, microsoftTools } from '@adport/provider-microsoft';
import { TikTokAdsProvider, TikTokClient, tiktokTools } from '@adport/provider-tiktok';
import { RedditAdsClient, RedditAdsProvider, redditTools } from '@adport/provider-reddit';
import { SnapchatAdsClient, SnapchatAdsProvider, snapchatTools } from '@adport/provider-snapchat';
import { SpotifyAdsClient, SpotifyAdsProvider, spotifyTools } from '@adport/provider-spotify';
import { PinterestAdsClient, PinterestAdsProvider, pinterestTools } from '@adport/provider-pinterest';
import { LinkedInAdsClient, LinkedInAdsProvider, linkedinTools } from '@adport/provider-linkedin';
import { XAdsClient, XAdsProvider, xTools } from '@adport/provider-x';
import { OpenAIAdsClient, OpenAIAdsProvider, openaiTools } from '@adport/provider-openai';
import { GravityClient, GravityProvider, gravityTools } from '@adport/provider-gravity';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../src/index.js';
import { ADPORT_UI_URI } from '../src/ui.js';

describe('all-provider shared tool surface', () => {
  let runtime: Awaited<ReturnType<typeof createContext>>;
  let names: string[];
  beforeAll(async () => {
    const google = new GoogleAdsProvider(new GoogleAdsRestClient({
      developerToken: 'x', clientId: 'x', clientSecret: 'x', refreshToken: 'x',
    }));
    const meta = new MetaAdsProvider(new MetaGraphClient({ accessToken: 'x' }));
    const tiktok = new TikTokAdsProvider(new TikTokClient({ accessToken: 'x' }), { appId: 'x', secret: 'x' });
    const apple = new AppleAdsProvider(new AppleAdsClient({
      clientId: 'x', teamId: 'x', keyId: 'x', privateKeyPem: 'x',
    }));
    const microsoft = new MicrosoftAdsProvider(new MicrosoftAdsClient({
      developerToken: 'x', clientId: 'x', refreshToken: 'x',
    }));
    const reddit = new RedditAdsProvider(new RedditAdsClient({
      clientId: 'x', clientSecret: 'x', refreshToken: 'x', userAgent: 'desktop:adport:test (by /u/test)',
    }));
    const snapchat = new SnapchatAdsProvider(new SnapchatAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const spotify = new SpotifyAdsProvider(new SpotifyAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const pinterest = new PinterestAdsProvider(new PinterestAdsClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }));
    const linkedin = new LinkedInAdsProvider(new LinkedInAdsClient({ accessToken: 'x' }));
    const x = new XAdsProvider(new XAdsClient({ consumerKey: 'x', consumerSecret: 'x', accessToken: 'x', accessTokenSecret: 'x' }));
    const openai = new OpenAIAdsProvider(new OpenAIAdsClient({ apiKey: 'x' }));
    const gravity = new GravityProvider(new GravityClient({ apiKey: 'x' }));

    runtime = await createContext({
      providerModules: [
        { provider: google, tools: googleTools(google) },
        { provider: meta, tools: metaTools(meta) },
        { provider: tiktok, tools: tiktokTools(tiktok) },
        { provider: apple, tools: appleTools(apple) },
        { provider: microsoft, tools: microsoftTools(microsoft) },
        { provider: reddit, tools: redditTools(reddit) },
        { provider: snapchat, tools: snapchatTools(snapchat) },
        { provider: spotify, tools: spotifyTools(spotify) },
        { provider: pinterest, tools: pinterestTools(pinterest) },
        { provider: linkedin, tools: linkedinTools(linkedin) },
        { provider: x, tools: xTools(x) },
        { provider: openai, tools: openaiTools(openai) },
        { provider: gravity, tools: gravityTools(gravity) },
      ],
    });
    names = runtime.registry.list().map((tool) => tool.name);
  });

  it('discovers hidden Meta workflows through a schema-valid MCP response while keeping execution disabled', async () => {
    const selected = selectRuntimeCatalog(runtime, { profile: 'standard', providers: ['google', 'meta'] }, false,
      { canWrite: true, manageAccessUrl: 'https://app.adport.test/dashboard/agents?connection=fixture' });
    const server = createMcpServer({ runtime: selected, productionOnly: true });
    const host = new Client({ name: 'capability-discovery', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await host.connect(clientTransport);
    try {
      const { tools } = await host.listTools();
      expect(tools.some(tool => tool.name === 'capabilities_list')).toBe(true);
      expect(tools.some(tool => tool.name === 'meta_create_lookalike_audience')).toBe(false);
      expect(tools.some(tool => /_api_/.test(tool.name))).toBe(false);
      const result = await host.callTool({ name: 'capabilities_list', arguments: { provider: 'meta', query: 'lookalike' } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ profile: 'standard', manage_access_url: expect.stringContaining('/dashboard/agents'),
        tools: expect.arrayContaining([expect.objectContaining({ name: 'meta_create_lookalike_audience', enabled: false, blockers: ['profile_disabled'] })]) });
      await expect(host.callTool({ name: 'meta_create_lookalike_audience', arguments: {} })).rejects.toThrow(/not found/);
    } finally { await host.close(); await server.close(); }
  });

  it('registers native read/create/update/delete tools once for both CLI and MCP adapters', async () => {
    expect(names).toEqual(expect.arrayContaining([
      'google_gaql', 'google_api_create', 'google_api_update', 'google_api_remove',
      'linkedin_media_context', 'linkedin_videos', 'linkedin_get_library_video', 'linkedin_get_document', 'linkedin_upload_video', 'linkedin_upload_document', 'linkedin_update_video',
      'meta_api_read', 'meta_api_create', 'meta_api_update', 'meta_api_delete',
      'tiktok_api_read', 'tiktok_api_create', 'tiktok_api_update', 'tiktok_api_delete',
      'apple_api_read', 'apple_api_create', 'apple_api_update', 'apple_api_delete',
      'apple_adgroups', 'apple_keywords', 'apple_negative_keywords', 'apple_ads', 'apple_creatives', 'apple_product_pages',
      'apple_create_keywords', 'apple_create_negative_keywords', 'apple_set_campaign_schedule', 'apple_create_creative', 'apple_create_ad',
      'microsoft_api_read', 'microsoft_api_create', 'microsoft_api_update', 'microsoft_api_delete',
      'reddit_api_read', 'reddit_api_create', 'reddit_api_update', 'reddit_api_delete',
      'snapchat_list_campaigns', 'snapchat_create_campaign', 'snapchat_set_campaign_status', 'snapchat_set_budget',
      'openai_conversion_sources', 'openai_conversion_event_settings', 'openai_conversion_events', 'openai_conversion_insights',
      'openai_list_campaigns', 'openai_ad_groups', 'openai_ads', 'openai_create_campaign', 'openai_set_campaign_status', 'openai_set_ad_group_status', 'openai_set_ad_status', 'openai_set_budget',
      'gravity_list_campaigns', 'gravity_ad_groups', 'gravity_conversions', 'gravity_billing', 'gravity_create_campaign', 'gravity_set_campaign_status', 'gravity_set_ad_group_status', 'gravity_set_ad_status', 'gravity_set_budget',
      'spotify_list_campaigns', 'spotify_get_ad_set', 'spotify_create_campaign_draft', 'spotify_set_campaign_status', 'spotify_set_budget', 'spotify_set_ad_set_delivery',
      'pinterest_list_campaigns', 'pinterest_create_campaign', 'pinterest_set_campaign_status', 'pinterest_set_budget',
      'pinterest_measurement_context', 'pinterest_conversion_tags', 'pinterest_get_conversion_tag', 'pinterest_create_conversion_tag', 'pinterest_conversion_tag_eligible_events', 'pinterest_conversion_tag_page_visits', 'pinterest_event_quality', 'pinterest_send_conversion_events',
      'pinterest_boards', 'pinterest_get_board', 'pinterest_update_board', 'pinterest_delete_empty_board', 'pinterest_pins', 'pinterest_get_pin', 'pinterest_get_media_upload',
      'pinterest_keyword_context', 'pinterest_keywords', 'pinterest_get_keyword', 'pinterest_keyword_metrics', 'pinterest_create_keywords', 'pinterest_archive_keywords',
      'pinterest_audiences', 'pinterest_get_audience', 'pinterest_audience_usage', 'pinterest_audience_sources', 'pinterest_customer_lists', 'pinterest_get_customer_list',
      'pinterest_create_audience', 'pinterest_update_audience', 'pinterest_replace_audience_rule', 'pinterest_remove_audience', 'pinterest_create_customer_list', 'pinterest_update_customer_list_records',
      'pinterest_create_board', 'pinterest_create_image_pin', 'pinterest_upload_video', 'pinterest_create_video_pin', 'pinterest_update_pin', 'pinterest_delete_pin',
      'linkedin_list_campaigns', 'linkedin_list_campaign_groups', 'linkedin_create_campaign', 'linkedin_set_campaign_status', 'linkedin_set_budget',
      'linkedin_budget_pricing', 'linkedin_supply_forecast',
      'linkedin_saved_audiences', 'linkedin_get_saved_audience', 'linkedin_create_saved_audience', 'linkedin_update_saved_audience', 'linkedin_delete_saved_audience',
      'x_list_campaigns', 'x_list_funding_instruments', 'x_list_line_items', 'x_create_campaign', 'x_set_campaign_status', 'x_set_budget',
    ]));
    expect(new Set(names).size).toBe(names.length);

    // Inspect what directory scanners actually receive, not only registry metadata.
    // No provider requests are made: all credentials above are inert test strings.
    const client = new Client({ name: 'submission-scanner-test', version: '1.0.0' });
    const server = createMcpServer({ runtime, includeRawTools: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const scanned = (await client.listTools()).tools;
      expect(scanned.map(tool => tool.name).sort()).toEqual([...names].sort());
      const reportName = scanned.find(tool => tool.name === 'spotify_create_report')!.inputSchema.properties!.name;
      expect(reportName).toMatchObject({ type: 'string', minLength: 2, maxLength: 120 });
      expect(reportName).not.toHaveProperty('pattern');
      const portablePatterns = (value: unknown, path: string): void => {
        if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
          // ChatGPT rejected the entire catalog for one JS-only Unicode pattern.
          if (key === 'pattern' && typeof item === 'string') expect(item, path).not.toMatch(/\\[pP]\{/);
          else portablePatterns(item, `${path}.${key}`);
        }
      };
      // Externally hosted private account data is not public/open-ended access.
      for (const name of ['accounts_list', 'report', 'audit_preview', 'audit_run',
        'meta_list_pages', 'meta_page_engagement', 'meta_api_read', 'meta_insights']) {
        expect(scanned.find(tool => tool.name === name)?.annotations?.openWorldHint, name).toBe(false);
      }
      // Delivery-affecting operations retain the more conservative external-action hint.
      expect(scanned.find(tool => tool.name === 'meta_set_campaign_status')?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: true, openWorldHint: true,
      });
      // Unattached audience creation is additive; it still requires the write policy gate.
      for (const name of ['meta_create_custom_audience', 'meta_create_website_audience', 'meta_create_lookalike_audience']) {
        expect(scanned.find(tool => tool.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      }
      expect(scanned.find(tool => tool.name === 'meta_delete_custom_audience')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      for (const tool of scanned) {
        portablePatterns(tool.inputSchema, `${tool.name}.inputSchema`);
        portablePatterns(tool.outputSchema, `${tool.name}.outputSchema`);
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.description, tool.name).toBeTruthy();
        const source = runtime.registry.list().find(candidate => candidate.name === tool.name)!;
        expect(tool.annotations, tool.name).toMatchObject({
          readOnlyHint: source.annotations.readOnly ?? false,
          destructiveHint: source.annotations.destructive ?? false,
          openWorldHint: source.annotations.openWorld ?? false,
        });
        expect(tool.inputSchema.type, tool.name).toBe('object');
        expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
        if (!tool.annotations?.readOnlyHint) expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('exposes named hosted tools and rejects every generic dispatcher through the SDK', async () => {
    const hosted = createMcpServer({ runtime, productionOnly: true });
    const hostedClient = new Client({ name: 'hosted-surface-test', version: '1.0.0' });
    const [hostClientTransport, hostServerTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([hosted.connect(hostServerTransport), hostedClient.connect(hostClientTransport)]);
    try {
      const hostedNames = (await hostedClient.listTools()).tools.map(tool => tool.name);
      expect(hostedNames).toContain('meta_get_campaign');
      expect(hostedNames).toContain('meta_list_campaigns');
      expect(hostedNames).toContain('meta_set_campaign_status');
      expect(hostedNames).toEqual(expect.arrayContaining([
        'google_experiments', 'google_experiment_context', 'google_experiment_async_errors', 'google_experiment_operation', 'google_create_experiment', 'google_update_experiment', 'google_add_experiment_arms', 'google_update_experiment_arms', 'google_remove_experiment_arms', 'google_remove_experiment', 'google_schedule_experiment', 'google_end_experiment', 'google_promote_experiment', 'google_graduate_experiment',
        'google_create_text_asset', 'google_performance_max_context', 'google_asset_groups', 'google_asset_group_context', 'google_asset_group_creatives', 'google_create_performance_max_campaign', 'google_create_asset_group', 'google_update_asset_group', 'google_set_asset_group_status', 'google_remove_asset_group', 'google_update_asset_group_assets', 'google_update_asset_group_copy', 'google_update_performance_max_brand_assets', 'google_add_asset_group_signals', 'google_remove_asset_group_signals', 'google_replace_asset_group_listing_filters',
        'google_field_metadata', 'google_labels', 'google_label_context', 'google_label_associations', 'google_create_label', 'google_update_label', 'google_remove_label', 'google_link_label', 'google_unlink_label',
        'google_negative_keyword_lists', 'google_create_negative_keyword_list', 'google_update_negative_keyword_list', 'google_link_negative_keyword_list', 'google_add_campaign_negative_keywords',
        'google_custom_conversion_goals', 'google_create_custom_conversion_goal', 'google_set_campaign_conversion_goal',
        'apple_adgroups', 'apple_keywords', 'apple_negative_keywords', 'apple_ads', 'apple_creatives', 'apple_product_pages',
        'apple_create_keywords', 'apple_create_negative_keywords', 'apple_set_campaign_schedule', 'apple_create_creative', 'apple_create_ad',
        'microsoft_audience_targets', 'microsoft_add_audience_target', 'microsoft_set_audience_target_bid', 'microsoft_remove_audience_target', 'microsoft_set_audience_target_mode',
        'microsoft_offline_conversion_reports', 'microsoft_offline_conversion_goal_report',
        'microsoft_experiments', 'microsoft_experiment_base_context', 'microsoft_get_experiment', 'microsoft_create_experiment', 'microsoft_update_experiment', 'microsoft_end_experiment', 'microsoft_delete_experiment',
      ]));
      const dispatchers = names.filter(name => name === 'recommendation_apply' || /_api_(read|create|update|delete|remove)$/.test(name));
      for (const name of dispatchers) {
        expect(hostedNames).not.toContain(name);
      }
      await Promise.all(dispatchers.map(name => expect(hostedClient.callTool({ name, arguments: {} })).rejects.toThrow(/not found/)));
    } finally { await hostedClient.close(); await hosted.close(); }
  }, 20_000);

  it('serves the complete named catalog and widget metadata over modern streamable HTTP', async () => {
    const modern = createMcpHandler(() => createMcpServer({ runtime, productionOnly: true }));
    const modernClient = new Client({ name: 'modern-directory-test', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await modernClient.connect(new StreamableHTTPClientTransport(new URL('https://adport.test/mcp'), { fetch: (url, init) => modern.fetch(new Request(url, init)) }));
      const modernTools = (await modernClient.listTools()).tools;
      expect(modernTools.map(tool => tool.name).sort()).toEqual(names.filter(name => name !== 'recommendation_apply' && !/_api_(read|create|update|delete|remove)$/.test(name)).sort());
      expect(modernTools.find(tool => tool.name === 'google_assets')?._meta).toMatchObject({ ui: { resourceUri: ADPORT_UI_URI } });
    } finally { await modernClient.close(); await modern.close(); }
  });

  it('exposes public feed inputs and rejects authentication before hosted project routing', async () => {
    const hash = 'a'.repeat(64);
    const project_id = '11111111-1111-4111-8111-111111111111';
    const scope = { project_id, account_id: '1' };
    const source = 'https://example.test/feed.csv';
    const acknowledgments = { acknowledge_shared_effects: true, acknowledge_automatic_processing: true };
    const tiktok = { ...scope, ...acknowledgments, bc_id: '1', catalog_id: '2', update_mode: 'INCREMENTAL' };
    const schedule = { source: { uri: source }, timezone: 'UTC', interval_type: 'DAILY' };
    const reddit = { ...scope, ...acknowledgments, business_id: '1e200a0b-4e98-32cc-dd47-3006e4c85bb2', catalog_id: 'catalog_1', mode: 'UPDATE', url: source };
    const pinterest = { ...scope, confirm_source_access: true };
    const feed = { catalog_type: 'RETAIL', catalog_id: '1', name: 'Catalog', format: 'CSV', location: source, default_country: 'US', default_locale: 'en-US' };
    const credentials = { username: 'fixture', password: 'fixture-only' };
    const cases = [
      { name: 'tiktok_create_catalog_feed', args: { ...tiktok, feed_name: 'Catalog', expected_catalog_hash: hash, schedule_param: schedule }, privateFields: { schedule_param: { ...schedule, source: { uri: source, ...credentials } } } },
      { name: 'tiktok_update_catalog_feed', args: { ...tiktok, feed_id: '3', expected_configuration_hash: hash, schedule_param: schedule }, privateFields: { schedule_param: { ...schedule, source: { uri: source, ...credentials } } } },
      { name: 'reddit_create_catalog_feed', args: { ...reddit, expected_catalog_configuration_hash: hash, schedule: null }, privateFields: credentials },
      { name: 'reddit_update_catalog_feed', args: { ...reddit, feed_id: 'feed_1', expected_configuration_hash: hash }, privateFields: credentials },
      { name: 'pinterest_create_feed', args: { ...pinterest, expected_context_hash: hash, feed }, privateFields: { feed: { ...feed, credentials } } },
      { name: 'pinterest_update_feed', args: { ...pinterest, catalog_id: '1', feed_id: '2', expected_snapshot_hash: hash, changes: { location: source } }, privateFields: { changes: { location: source, credentials } } },
    ];
    const resolve = vi.fn(async () => { throw new Error('Fixture stops at project routing'); });
    const routed = withProjectRouting(runtime, { list: async () => [], resolve });
    const server = createMcpServer({ runtime: routed, productionOnly: true });
    const client = new Client({ name: 'hosted-feed-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      for (const { name, args, privateFields } of cases) {
        const schema = tools.find(tool => tool.name === name)?.inputSchema;
        expect(schema?.properties).toHaveProperty('project_id');
        expect(JSON.stringify(schema)).not.toMatch(/"(username|password|credentials)":/);
        const local = runtime.registry.get(name).input;
        const { project_id: _projectId, ...localArgs } = { ...args, ...privateFields };
        expect(local.safeParse(localArgs).success, name).toBe(true);
        resolve.mockClear();
        const rejected = await client.callTool({ name, arguments: { ...args, ...privateFields } });
        expect(rejected).toMatchObject({ isError: true, content: [expect.objectContaining({ text: expect.stringMatching(/unrecognized key/i) })] });
        expect(resolve).not.toHaveBeenCalled();
        await client.callTool({ name, arguments: args });
        expect(resolve).toHaveBeenCalledWith(project_id, expect.objectContaining({ name }));
      }
      resolve.mockClear();
      const rejectedUrl = await client.callTool({
        name: 'reddit_create_catalog_feed',
        arguments: { ...cases[2]!.args, url: source + '?token=fixture-only' },
      });
      expect(rejectedUrl).toMatchObject({ isError: true, content: [expect.objectContaining({ text: expect.stringMatching(/public HTTPS feed URL/i) })] });
      expect(resolve).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
  it('defaults to typed tools, filters profiles and platforms, and rejects excluded calls', async () => {
    async function unavailable(client: Client, name: string) {
      try { expect((await client.callTool({ name, arguments: {} })).isError).toBe(true); }
      catch (error) { expect(String(error)).toMatch(/not found|Unknown tool/); }
    }
    const catalogs: Record<string, number> = {};
    for (const [label, catalog] of Object.entries({
      full: { profile: 'full' as const, providers: null },
      standard: { profile: 'standard' as const, providers: ['google', 'meta'] as const },
      reporting: { profile: 'reporting' as const, providers: ['google', 'meta'] as const },
      empty: { profile: 'standard' as const, providers: [] },
    })) {
      const server = createMcpServer({ runtime, productionOnly: true, catalog, includeRawTools: true });
      const client = new Client({ name: `catalog-${label}`, version: '1.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      try {
        const tools = (await client.listTools()).tools;
        const listed = tools.map(tool => tool.name);
        catalogs[label] = tools.length;
        expect(listed.some(name => /_api_/.test(name))).toBe(false);
        if (label !== 'full') {
          expect(listed.some(name => /^(apple|tiktok|microsoft|reddit|snapchat|spotify|pinterest|linkedin|x|openai|gravity)_/.test(name))).toBe(false);
          await unavailable(client, 'apple_create_campaign');
        }
        if (label === 'standard') {
          expect(listed).toEqual(expect.arrayContaining(['accounts_list', 'report', 'meta_insights', 'meta_create_campaign', 'meta_create_ad_set', 'meta_create_ad', 'google_create_responsive_search_ad']));
          expect(listed).not.toContain('google_create_experiment');
        }
        if (label === 'reporting') {
          expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
          await unavailable(client, 'meta_set_budget');
        }
        if (label === 'empty') expect(listed.some(name => /^(google|meta)_/.test(name))).toBe(false);
        await unavailable(client, 'meta_api_read');
      } finally { await client.close(); await server.close(); }
    }
    expect(catalogs.standard).toBeLessThan(catalogs.full! / 3);
    console.log('Catalog sizes:', JSON.stringify(catalogs));
    const server = createMcpServer({ runtime });
    const client = new Client({ name: 'default-local-catalog', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try { expect((await client.listTools()).tools.some(tool => /_api_/.test(tool.name))).toBe(false); }
    finally { await client.close(); await server.close(); }
  }, 20_000);

});

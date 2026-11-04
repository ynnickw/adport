import { createContext } from '@adport/core';
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
import { beforeAll, describe, expect, it } from 'vitest';
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
      ],
    });
    names = runtime.registry.list().map((tool) => tool.name);
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
          expect(listed.some(name => /^(apple|tiktok|microsoft|reddit|snapchat|spotify|pinterest|linkedin|x)_/.test(name))).toBe(false);
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

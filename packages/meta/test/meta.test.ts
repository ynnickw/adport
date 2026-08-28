import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '@adport/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaGraphClient, formatMetaError, normalizeAccountId } from '../src/client.js';
import { CENTS_TO_MICROS, MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(
  routes: Array<{ match: (url: string, body: string) => boolean; reply: unknown | (() => unknown); status?: number }>,
) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    const body = String(init?.body ?? '');
    calls.push({ url: urlStr, init: init ?? {} });
    const route = routes.find((r) => r.match(urlStr, body));
    if (!route) throw new Error(`Unmatched fetch: ${urlStr}\n${body}`);
    const reply = typeof route.reply === 'function' ? (route.reply as () => unknown)() : route.reply;
    return new Response(JSON.stringify(reply), { status: route.status ?? 200 });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const CREDS = { accessToken: 'EAAJB-test-token' };

// Response shapes below mirror the live Marketing API reference docs (v25.0),
// including string-typed numbers and the paging envelope.

const adaccountsReply = {
  data: [
    { id: 'act_426197654150180', account_id: '426197654150180', name: 'Acme Meta', currency: 'EUR', account_status: 1 },
    { id: 'act_98765', account_id: '98765', name: 'Old Account', currency: 'USD', account_status: 101 },
  ],
  paging: { cursors: { before: 'NDMyNzQyODI3OTQw', after: 'MTAxNTExOTQ1MjAwNzI5NDE=' } },
};

const insightsReply = {
  data: [
    {
      account_id: '426197654150180',
      campaign_id: '23851234567890123',
      campaign_name: 'Prospecting DE',
      date_start: '2026-07-29',
      date_stop: '2026-08-04',
      spend: '5339.5',
      impressions: '361324',
      clicks: '8123',
      actions: [
        { action_type: 'omni_purchase', value: '23' },
        { action_type: 'link_click', value: '8123' },
      ],
      action_values: [{ action_type: 'omni_purchase', value: '5210.3' }],
    },
  ],
  paging: { cursors: { before: 'MAZDZD', after: 'MAZDZD' } },
};

describe('normalizeAccountId', () => {
  it('strips the act_ prefix', () => {
    expect(normalizeAccountId('act_426197654150180')).toBe('426197654150180');
    expect(normalizeAccountId('426197654150180')).toBe('426197654150180');
  });
  it('rejects non-numeric ids', () => {
    expect(() => normalizeAccountId('acme')).toThrow(/not a valid/);
  });
});

describe('formatMetaError', () => {
  it('renders the documented error shape with fbtrace_id and a 190 hint', () => {
    const message = formatMetaError(
      400,
      JSON.stringify({
        error: {
          message: 'Error validating access token: Session has expired',
          type: 'OAuthException',
          code: 190,
          error_subcode: 463,
          fbtrace_id: 'EJplcsCHuLu',
        },
      }),
    );
    expect(message).toContain('code 190');
    expect(message).toContain('subcode 463');
    expect(message).toContain('adport connect meta');
    expect(message).toContain('[fbtrace_id: EJplcsCHuLu]');
  });
});

describe('MetaAdsProvider.listAccounts', () => {
  it('maps account_status codes and sends Bearer auth', async () => {
    const { impl, calls } = fakeFetch([{ match: (url) => url.includes('/me/adaccounts'), reply: adaccountsReply }]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const accounts = await provider.listAccounts();
    expect(accounts).toEqual([
      { provider: 'meta', id: '426197654150180', name: 'Acme Meta', currency: 'EUR', status: 'ACTIVE' },
      { provider: 'meta', id: '98765', name: 'Old Account', currency: 'USD', status: 'CLOSED' },
    ]);
    const call = calls[0]!;
    expect(call.url).toContain('graph.facebook.com/v25.0/me/adaccounts');
    expect(call.url).toContain('fields=account_id%2Cname%2Ccurrency%2Caccount_status');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer EAAJB-test-token');
  });
});

describe('Meta Page reads', () => {
  it('lists accessible Pages without requesting or returning Page access tokens', async () => {
    const { impl, calls } = fakeFetch([
      {
        match: (url) => url.includes('/me/accounts'),
        reply: { data: [{ id: '12345', name: 'Adport Test Page', category: 'Software', tasks: ['MANAGE'] }] },
      },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await expect(provider.listPages()).resolves.toEqual([
      { id: '12345', name: 'Adport Test Page', category: 'Software', tasks: ['MANAGE'] },
    ]);
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain('/me/accounts');
    expect(url).toContain('fields=id,name,category,tasks');
    expect(url).not.toContain('access_token');
  });

  it('verifies Page access before reading Page metadata and post engagement', async () => {
    const { impl, calls } = fakeFetch([
      {
        match: (url) => url.includes('/me/accounts'),
        reply: { data: [{ id: '12345', name: 'Adport Test Page', tasks: ['MANAGE'] }] },
      },
      {
        match: (url) => url.includes('/v25.0/12345?'),
        reply: { id: '12345', name: 'Adport Test Page', fan_count: 2, followers_count: 3 },
      },
      {
        match: (url) => url.includes('/12345/posts'),
        reply: {
          data: [{
            id: '12345_67890',
            message: 'Verification test',
            created_time: '2026-08-28T12:00:00+0000',
            shares: { count: 1 },
            likes: { summary: { total_count: 2 } },
            comments: { summary: { total_count: 3 } },
          }],
        },
      },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const result = await provider.pageEngagement({ page_id: '12345', post_limit: 10 });
    expect(result.page).toMatchObject({ id: '12345', followers_count: 3 });
    expect(result.posts).toEqual([
      expect.objectContaining({ id: '12345_67890', likes: 2, comments: 3, shares: 1 }),
    ]);
    expect(decodeURIComponent(calls[2]!.url)).toContain('likes.limit(0).summary(true)');
  });

  it('rejects Page ids outside the connected user grant', async () => {
    const { impl } = fakeFetch([{ match: (url) => url.includes('/me/accounts'), reply: { data: [] } }]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await expect(provider.pageEngagement({ page_id: '999' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('MetaAdsProvider.report', () => {
  it('queries act_<id>/insights with time_range and normalizes string metrics', async () => {
    const { impl, calls } = fakeFetch([{ match: (url) => url.includes('/insights'), reply: insightsReply }]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const report = await provider.report({
      accountIds: ['426197654150180'],
      level: 'campaign',
      metrics: ['spend', 'clicks', 'conversions', 'conversion_value', 'roas', 'ctr'],
      dateRange: { start: '2026-07-29', end: '2026-08-04' },
    });
    const row = report.rows[0]!;
    expect(row.entity).toEqual({ level: 'campaign', id: '23851234567890123', name: 'Prospecting DE' });
    expect(row.metrics.spend).toBe(5339.5);
    expect(row.metrics.clicks).toBe(8123);
    expect(row.metrics.conversions).toBe(23); // omni_purchase only, not link_click
    expect(row.metrics.conversion_value).toBe(5210.3);
    expect(row.metrics.roas).toBe(0.98);
    expect(row.metrics.ctr).toBe(2.25);

    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain('/act_426197654150180/insights');
    expect(url).toContain('level=campaign');
    expect(url).toContain('"since":"2026-07-29"');
    expect(url).toContain('"until":"2026-08-04"');
  });
});

describe('MetaAdsProvider writes', () => {
  it('maps recommendation pauses to the guarded campaign status tool', () => {
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', vi.fn() as unknown as typeof fetch));
    expect(provider.standardActions().pauseCampaign?.('426197654150180', '123')).toEqual({
      tool: 'meta_set_campaign_status',
      input: { account_id: '426197654150180', campaign_id: '123', status: 'PAUSED' },
    });
  });

  it('previews campaign creation via execution_options=validate_only with paused coercion', async () => {
    const { impl, calls } = fakeFetch([
      {
        match: (url, body) => url.includes('/campaigns') && body.includes('validate_only'),
        reply: { success: true },
      },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const preview = await provider.previewWrite(
      {
        tool: 'meta_create_campaign',
        provider: 'meta',
        accountId: 'act_426197654150180',
        kind: 'create',
        payload: { name: 'August Sale', objective: 'OUTCOME_SALES', status: 'ACTIVE', special_ad_categories: [] },
      },
      { forcePausedCreation: true },
    );
    expect(preview.serverValidated).toBe(true);
    expect(preview.coercions).toHaveLength(1);

    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(calls[0]!.url).toContain('/act_426197654150180/campaigns');
    expect(body.get('status')).toBe('PAUSED');
    expect(body.get('objective')).toBe('OUTCOME_SALES');
    expect(body.get('special_ad_categories')).toBe('[]'); // required by the API even when empty
    expect(body.get('is_adset_budget_sharing_enabled')).toBe('false');
    expect(body.get('execution_options')).toBe('["validate_only"]');
  });

  it('supports explicit ad set budget sharing for campaigns without a campaign budget', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/campaigns'), reply: { success: true } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await provider.previewWrite(
      {
        tool: 'meta_create_campaign',
        provider: 'meta',
        accountId: '426197654150180',
        kind: 'create',
        payload: {
          name: 'Shared ad set budgets',
          objective: 'OUTCOME_TRAFFIC',
          special_ad_categories: [],
          is_adset_budget_sharing_enabled: true,
        },
      },
      { forcePausedCreation: true },
    );
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('is_adset_budget_sharing_enabled')).toBe('true');
    expect(body.get('daily_budget')).toBeNull();
  });

  it('omits ad set budget sharing when the campaign owns the budget', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/campaigns'), reply: { success: true } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await provider.previewWrite(
      {
        tool: 'meta_create_campaign',
        provider: 'meta',
        accountId: '426197654150180',
        kind: 'create',
        payload: {
          name: 'Campaign budget',
          objective: 'OUTCOME_TRAFFIC',
          special_ad_categories: [],
          daily_budget_cents: 5000,
        },
      },
      { forcePausedCreation: true },
    );
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('daily_budget')).toBe('5000');
    expect(body.get('is_adset_budget_sharing_enabled')).toBeNull();
  });

  it('applies campaign creation without execution_options and returns the new id', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/campaigns'), reply: { id: '23851234567890123' } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const result = await provider.applyWrite(
      {
        tool: 'meta_create_campaign',
        provider: 'meta',
        accountId: '426197654150180',
        kind: 'create',
        payload: { name: 'August Sale', objective: 'OUTCOME_SALES', special_ad_categories: [] },
      },
      { forcePausedCreation: true },
    );
    expect(result.resourceIds).toEqual(['23851234567890123']);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('execution_options')).toBeNull();
  });

  it('previews a budget change with a lookup and converts cents to micros for policy', async () => {
    const { impl } = fakeFetch([
      {
        match: (url) => url.includes('/120210000000/') || url.includes('/120210000000?'),
        reply: { name: 'Prospecting DE', daily_budget: '5000', id: '120210000000' },
      },
      { match: (url, body) => url.includes('/120210000000') && body.includes('daily_budget'), reply: { success: true } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const preview = await provider.previewWrite(
      {
        tool: 'meta_set_budget',
        provider: 'meta',
        accountId: '426197654150180',
        kind: 'update',
        payload: { object_id: '120210000000', daily_budget_cents: 6000 },
      },
      { forcePausedCreation: true },
    );
    expect(preview.budgetDeltas[0]).toEqual({
      target: '"Prospecting DE" daily budget',
      fromMicros: 5000 * CENTS_TO_MICROS,
      toMicros: 6000 * CENTS_TO_MICROS,
    });
  });

  it('fails clearly when the object has no daily_budget', async () => {
    const { impl } = fakeFetch([
      { match: (url) => url.includes('/120210000000'), reply: { name: 'CBO child adset', id: '120210000000' } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await expect(
      provider.previewWrite(
        {
          tool: 'meta_set_budget',
          provider: 'meta',
          accountId: '426197654150180',
          kind: 'update',
          payload: { object_id: '120210000000', daily_budget_cents: 6000 },
        },
        { forcePausedCreation: true },
      ),
    ).rejects.toThrow(/no daily_budget/);
  });

  it('creates an ad set with JSON-encoded targeting', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/adsets'), reply: { id: '120210000001' } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const result = await provider.applyWrite(
      {
        tool: 'meta_create_ad_set',
        provider: 'meta',
        accountId: '426197654150180',
        kind: 'create',
        payload: { campaign_id: '23851234567890123', name: 'DE broad', countries: ['DE'], daily_budget_cents: 2000 },
      },
      { forcePausedCreation: true },
    );
    expect(result.resourceIds).toEqual(['120210000001']);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(JSON.parse(body.get('targeting')!)).toEqual({ geo_locations: { countries: ['DE'] } });
    expect(body.get('optimization_goal')).toBe('LINK_CLICKS');
    expect(body.get('billing_event')).toBe('IMPRESSIONS');
    expect(body.get('status')).toBe('PAUSED');
  });

  it('reads arbitrary ad-account edges with pagination parameters', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/act_426197654150180/adcreatives'), reply: { data: [{ id: '44' }] } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await expect(provider.apiRead({
      account_id: '426197654150180', edge: 'adcreatives', fields: ['id', 'name'], params: { limit: '25' },
    })).resolves.toEqual([{ id: '44' }]);
    expect(decodeURIComponent(calls[0]!.url)).toContain('fields=id,name');
  });

  it('guards generic creates, forces PAUSED, and checks budget fields', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/adsets'), reply: { success: true } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const preview = await provider.previewWrite({
      tool: 'meta_api_create', provider: 'meta', accountId: '426197654150180', kind: 'create',
      payload: { edge: 'adsets', fields: { name: 'Native', status: 'ACTIVE', daily_budget: 2500 } },
    }, { forcePausedCreation: true });
    expect(preview.coercions).toHaveLength(1);
    expect(preview.budgetDeltas).toEqual([{ target: 'fields.daily_budget', toMicros: 25_000_000 }]);
    expect(preview.serverValidated).toBe(false);
    expect(calls).toHaveLength(0);
    await provider.applyWrite({
      tool: 'meta_api_create', provider: 'meta', accountId: '426197654150180', kind: 'create',
      payload: { edge: 'adsets', fields: { name: 'Native', status: 'ACTIVE', daily_budget: 2500 } },
    }, { forcePausedCreation: true });
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get('status')).toBe('PAUSED');
    expect(body.get('execution_options')).toBeNull();
  });

  it('checks object ownership and does not delete during client-side preview', async () => {
    const { impl, calls } = fakeFetch([
      { match: (url) => url.includes('/123?fields=account_id'), reply: { account_id: '426197654150180' } },
      { match: (url) => url.endsWith('/123'), reply: { success: true } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const op = {
      tool: 'meta_api_delete', provider: 'meta', accountId: '426197654150180', kind: 'remove' as const,
      payload: { object_id: '123' },
    };
    const preview = await provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview.serverValidated).toBe(false);
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(false);
    await provider.applyWrite(op, { forcePausedCreation: true });
    expect(calls.some((call) => call.init.method === 'DELETE')).toBe(true);
  });

  it('rejects cross-account generic updates and generic budget updates', async () => {
    const { impl } = fakeFetch([
      { match: (url) => url.includes('/123?fields=account_id'), reply: { account_id: '999' } },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    await expect(provider.previewWrite({
      tool: 'meta_api_update', provider: 'meta', accountId: '426197654150180', kind: 'update',
      payload: { object_id: '123', fields: { name: 'Wrong account' } },
    }, { forcePausedCreation: true })).rejects.toThrow('does not belong');
    await expect(provider.previewWrite({
      tool: 'meta_api_update', provider: 'meta', accountId: '426197654150180', kind: 'update',
      payload: { object_id: '123', fields: { lifetime_budget: 1 } },
    }, { forcePausedCreation: true })).rejects.toThrow('budget updates require a typed budget tool');
  });
});

describe('end-to-end through the shared tool registry (policy engine + meta tools)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'adport-meta-test-'));
    process.env.ADPORT_HOME = home;
  });

  afterEach(() => {
    delete process.env.ADPORT_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('runs the two-step budget write and rejects over-cap changes', async () => {
    const { impl } = fakeFetch([
      {
        match: (url) => url.includes('/120210000000'),
        reply: { name: 'Prospecting DE', daily_budget: '5000', id: '120210000000' },
      },
    ]);
    const provider = new MetaAdsProvider(new MetaGraphClient(CREDS, 'v25.0', impl));
    const { ctx, registry } = await createContext({
      providerModules: [{ provider, tools: metaTools(provider) }],
      includeMock: false,
    });

    // +20% passes the default 25% cap: validate, then apply.
    const args = { account_id: '426197654150180', object_id: '120210000000', daily_budget_cents: 6000 };
    const first = (await registry.call('meta_set_budget', args, ctx)) as {
      status: string;
      pending_operation_id: string;
      preview: { serverValidated: boolean };
    };
    expect(first.status).toBe('pending_validation');
    expect(first.preview.serverValidated).toBe(true);

    const second = (await registry.call(
      'meta_set_budget',
      { ...args, pending_operation_id: first.pending_operation_id },
      ctx,
    )) as { status: string };
    expect(second.status).toBe('applied');

    // +140% violates the default cap before any mutation happens.
    await expect(
      registry.call('meta_set_budget', { ...args, daily_budget_cents: 12_000 }, ctx),
    ).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
  });
});

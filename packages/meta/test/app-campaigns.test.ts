import { describe, expect, it, vi } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MetaGraphClient } from '../src/client.js';
import { MetaAdsProvider } from '../src/provider.js';
import { metaTools } from '../src/tools.js';

// Native fields/edge types checked against Meta's official Business SDK,
// meta/facebook-python-business-sdk@99b5e2db19e60e63f753154b36dad684cbbd3088 (2026-11-05).
const account = '123', campaignId = '456', appId = '789';
const app = { application_id: appId, object_store_url: 'https://apps.apple.com/app/id123456789' };
const guard = { forcePausedCreation: true };
const parent = { id: campaignId, account_id: account, name: 'QA parent', status: 'PAUSED', objective: 'OUTCOME_APP_PROMOTION', is_skadnetwork_attribution: true, promoted_object: { application_id: appId } };

function fixture(options: { parent?: unknown; applications?: unknown; page?: unknown } = {}) {
  let currentParent: unknown = options.parent ?? parent;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'GET' && url.pathname.endsWith('/advertisable_applications')) return Response.json(options.page ?? { data: options.applications ?? [{ id: appId, name: 'QA app', object_store_urls: { iphone: app.object_store_url }, app_secret: 'must not return' }] });
    if (init?.method === 'GET' && url.pathname.endsWith('/' + campaignId)) return Response.json(currentParent);
    if (init?.method === 'POST' && /\/(campaigns|adsets)$/.test(url.pathname)) return Response.json({ success: true, id: '999' });
    throw new Error(`Unexpected native call: ${init?.method} ${url.pathname}`);
  });
  return { provider: new MetaAdsProvider(new MetaGraphClient({ accessToken: 'test' }, 'v25.0', fetch)), fetch, setParent: (value: unknown) => { currentParent = value; } };
}

function campaign(payload: Record<string, unknown> = {}): WriteOperation {
  return { tool: 'meta_create_campaign', provider: 'meta', accountId: account, kind: 'create', payload: { name: 'App QA', objective: 'OUTCOME_APP_PROMOTION', status: 'ACTIVE', promoted_object: app, is_skadnetwork_attribution: true, ...payload } };
}
function adSet(payload: Record<string, unknown> = {}): WriteOperation {
  return { tool: 'meta_create_ad_set', provider: 'meta', accountId: account, kind: 'create', payload: { campaign_id: campaignId, name: 'App QA', countries: ['US'], daily_budget_cents: 100, promoted_object: app, user_os: ['iOS_ver_14.0_and_above'], ...payload } };
}
const postBodies = (fetch: ReturnType<typeof fixture>['fetch']) => fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => new URLSearchParams(String(init?.body)));

describe('Meta app campaign binding', () => {
  it('discovers only the account app edge, strips credentials and keeps cursor scope', async () => {
    const { provider, fetch } = fixture({ page: { data: [{ id: appId, name: 'QA', object_store_urls: { iphone: app.object_store_url }, app_secret: 'secret' }], paging: { cursors: { after: 'page2' }, next: 'https://graph.facebook.com/v25.0/act_123/advertisable_applications?after=page2&access_token=secret' } } });
    const result = await provider.advertisableApplications({ account_id: account, app_id: appId, limit: 10, after: 'page1' });
    expect(result).toEqual({ applications: [{ id: appId, name: 'QA', object_store_urls: { iphone: app.object_store_url } }], count: 1, next_cursor: 'page2', truncated: true });
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v25.0/act_123/advertisable_applications');
    expect(Object.fromEntries(url.searchParams)).toEqual({ fields: 'id,name,object_store_urls', limit: '10', app_id: appId, after: 'page1' });
  });

  it('encodes campaign binding and SKAdNetwork flag at creation in validate-only and apply', async () => {
    const { provider, fetch } = fixture();
    const preview = await provider.previewWrite(campaign(), guard);
    expect(preview).toMatchObject({ serverValidated: true, budgetDeltas: [] });
    expect(preview.changes.join(' ')).toContain('application 789');
    expect(preview.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);
    const body = postBodies(fetch)[0]!;
    expect(body.get('promoted_object')).toBe(JSON.stringify(app));
    expect(body.get('is_skadnetwork_attribution')).toBe('true');
    expect(body.get('status')).toBe('PAUSED');
    expect(body.get('execution_options')).toBe('["validate_only"]');
    await provider.applyWrite(campaign(), guard);
    const applied = postBodies(fetch)[1]!;
    body.delete('execution_options');
    expect(applied.toString()).toBe(body.toString());
    expect(fetch.mock.calls.filter(([url, init]) => init?.method === 'GET' && String(url).includes('/advertisable_applications'))).toHaveLength(2);
  });

  it.each([
    { promoted_object: undefined },
    { promoted_object: { application_id: appId } },
    { objective: 'OUTCOME_TRAFFIC' },
  ])('rejects incomplete SKAdNetwork campaigns before native calls: %j', async payload => {
    const { provider, fetch } = fixture();
    await expect(provider.previewWrite(campaign(payload), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an app unavailable to the selected account without posting', async () => {
    const { provider, fetch } = fixture({ applications: [] });
    await expect(provider.previewWrite(campaign(), guard)).rejects.toThrow(/not available/);
    expect(postBodies(fetch)).toHaveLength(0);
  });

  it('rejects an unexpected application filter result', async () => {
    const { provider, fetch } = fixture({ applications: [{ id: '999' }] });
    await expect(provider.previewWrite(campaign(), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(postBodies(fetch)).toHaveLength(0);
  });

  it('validates app ad sets against the owned parent and sends explicit store and OS fields', async () => {
    const { provider, fetch } = fixture();
    const preview = await provider.previewWrite(adSet(), guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'new ad set "App QA" daily budget', toMicros: 1_000_000 }]);
    const body = postBodies(fetch)[0]!;
    expect(body.get('campaign_id')).toBe(campaignId);
    expect(body.get('promoted_object')).toBe(JSON.stringify(app));
    expect(body.get('optimization_goal')).toBe('APP_INSTALLS');
    expect(JSON.parse(body.get('targeting')!)).toEqual({ geo_locations: { countries: ['US'] }, user_os: ['iOS_ver_14.0_and_above'] });
    expect(body.get('status')).toBe('PAUSED');
    expect(body.get('execution_options')).toBe('["validate_only"]');
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v25.0/456', '/v25.0/act_123/advertisable_applications', '/v25.0/act_123/adsets']);
  });

  it.each([
    { ...parent, account_id: '999' },
    { ...parent, id: '999' },
    { ...parent, objective: 'OUTCOME_TRAFFIC' },
    { ...parent, promoted_object: null },
    { ...parent, promoted_object: { application_id: '999' } },
    { ...parent, promoted_object: { application_id: appId, object_store_url: 'https://apps.apple.com/app/id987654321' } },
  ])('rejects mismatched or unbound parents before posting: %j', async current => {
    const { provider, fetch } = fixture({ parent: current });
    await expect(provider.previewWrite(adSet(), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(postBodies(fetch)).toHaveLength(0);
  });

  it('does not infer the ad-set app binding from the parent', async () => {
    const { provider, fetch } = fixture();
    await expect(provider.previewWrite(adSet({ promoted_object: undefined }), guard)).rejects.toThrow(/require promoted_object/);
    expect(postBodies(fetch)).toHaveLength(0);
  });

  it('rechecks parent ownership/binding at apply and rejects drift before creation', async () => {
    const { provider, fetch, setParent } = fixture();
    await provider.previewWrite(adSet(), guard);
    setParent({ ...parent, promoted_object: { application_id: '999' } });
    await expect(provider.applyWrite(adSet(), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(postBodies(fetch)).toHaveLength(1);
    expect(postBodies(fetch)[0]!.get('execution_options')).toBe('["validate_only"]');
  });

  it('keeps typed schemas strict for app IDs, store URLs and SKAdNetwork prerequisites', () => {
    const { provider } = fixture(), tools = metaTools(provider);
    const create = tools.find(tool => tool.name === 'meta_create_campaign')!;
    const base = { account_id: account, name: 'QA', objective: 'OUTCOME_APP_PROMOTION', is_skadnetwork_attribution: true };
    expect(create.input.safeParse(base).success).toBe(false);
    expect(create.input.safeParse({ ...base, promoted_object: { application_id: appId } }).success).toBe(false);
    expect(create.input.safeParse({ ...base, promoted_object: app }).success).toBe(true);
    expect(create.input.safeParse({ ...base, promoted_object: { ...app, object_store_url: 'http://itunes.apple.com/app/id6765692747' } }).success).toBe(true);
    for (const value of [{ application_id: 'not-an-id' }, { ...app, access_token: 'secret' }, { ...app, object_store_url: 'https://user:pass@store.test/app' }, { ...app, object_store_url: 'file:///app' }]) {
      expect(create.input.safeParse({ ...base, promoted_object: value }).success).toBe(false);
    }
    const set = tools.find(tool => tool.name === 'meta_create_ad_set')!;
    expect(set.input.safeParse({ account_id: account, campaign_id: campaignId, name: 'QA', countries: ['US'], promoted_object: { application_id: appId } }).success).toBe(false);
    const discover = tools.find(tool => tool.name === 'meta_advertisable_applications')!;
    expect(discover.annotations.readOnly).toBe(true);
    expect(discover.input.safeParse({ account_id: account, after: '\n' }).success).toBe(false);
  });
});

import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Google Ads API v25 AdGroupCriterion (final_urls, final_mobile_urls: repeated
// string; tracking_url_template, final_url_suffix: string; negative and keyword
// immutable) and the ad_group_criterion GAQL field reference (all four URL
// fields selectable and filterable): developers.google.com/google-ads/api/
// reference/rpc/v25/AdGroupCriterion and /fields/v25/ad_group_criterion,
// checked 2026-11-25. Fields named in update_mask but absent from the update
// are cleared (FieldMask semantics). Fixtures only; no live API contact.
type Row = Record<string, any>;
const A = '1234567890', ROOT = `customers/${A}`, guard = { forcePausedCreation: true };
const crit = (adGroup: string, id: string, text: string, extra: Row = {}): Row => ({ resourceName: `${ROOT}/adGroupCriteria/${adGroup}~${id}`, criterionId: id, type: 'KEYWORD', status: 'ENABLED', negative: false, keyword: { text, matchType: 'EXACT' }, ...extra });
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'google', tool, accountId: A, kind, payload });

function fixture(options: { criteria?: Row[]; receipt?: (names: string[]) => string[]; mutateError?: boolean } = {}) {
  const criteria = options.criteria ?? [
    crit('22', '101', 'running shoes', { finalUrls: ['https://shop.example/old'] }),
    crit('33', '202', 'trail shoes', { trackingUrlTemplate: '{lpurl}?src=old', finalUrlSuffix: 'utm=old' }),
  ];
  const calls: Array<{ url: URL; body: Row; init: RequestInit }> = [];
  const client = new GoogleAdsRestClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert' }, 'v25', async (raw, init = {}) => {
    const url = new URL(String(raw));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
    const body = JSON.parse(String(init.body ?? '{}'));
    calls.push({ url, body, init });
    if (url.pathname.endsWith('googleAds:search')) {
      const query = String(body.query), names = [...query.matchAll(/'(customers\/[^']+)'/g)].map(match => match[1]);
      const rows = query.includes('resource_name IN') ? criteria.filter(row => names.includes(row.resourceName)) : criteria;
      return Response.json({ results: rows.map(row => ({ campaign: { id: '11' }, adGroup: { id: row.resourceName.split('/').at(-1).split('~')[0] }, adGroupCriterion: row })) });
    }
    if (options.mutateError) return new Response(JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ requestId: 'req-kw', errors: [{ errorCode: { urlFieldError: 'INVALID_TAG_IN_TRACKING_URL_TEMPLATE' }, message: 'Invalid tag.' }] }] } }), { status: 400 });
    const names = (body.operations as Row[]).map(item => item.update?.resourceName ?? `${ROOT}/adGroupCriteria/22~${900 + calls.length}`);
    return Response.json(body.validateOnly ? {} : { results: (options.receipt?.(names) ?? names).map(resourceName => ({ resourceName })) });
  });
  return { calls, provider: new GoogleAdsProvider(client) };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.pathname.endsWith(':mutate'));

describe('google_add_keywords landing pages', () => {
  it('maps keyword URL fields onto AdGroupCriterion creates', async () => {
    const f = fixture();
    const preview = await f.provider.previewWrite(op('google_add_keywords', { ad_group_id: '22', negative: false, keywords: [
      { text: 'red shoes', match_type: 'PHRASE', final_urls: ['https://shop.example/red'], final_mobile_urls: ['https://m.shop.example/red'], tracking_url_template: '{lpurl}?kw={keyword}', final_url_suffix: 'utm_source=google' },
      { text: 'blue shoes', match_type: 'EXACT' },
    ] }, 'create'), guard);
    const [call] = mutations(f);
    expect(call!.init.method).toBe('POST');
    expect(call!.url.pathname).toBe(`/v25/${ROOT}/adGroupCriteria:mutate`);
    expect(call!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [
      { create: { adGroup: `${ROOT}/adGroups/22`, status: 'ENABLED', negative: false, keyword: { text: 'red shoes', matchType: 'PHRASE' }, finalUrls: ['https://shop.example/red'], finalMobileUrls: ['https://m.shop.example/red'], trackingUrlTemplate: '{lpurl}?kw={keyword}', finalUrlSuffix: 'utm_source=google' } },
      { create: { adGroup: `${ROOT}/adGroups/22`, status: 'ENABLED', negative: false, keyword: { text: 'blue shoes', matchType: 'EXACT' } } },
    ] });
    expect(preview.changes[0]).toContain('https://shop.example/red');
  });

  it('rejects URL fields on negatives and unsafe URLs before any request', async () => {
    const f = fixture(), rt = await createContext({ providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const call = (keywords: Row[], negative = false) => rt.registry.call('google_add_keywords', { account_id: A, ad_group_id: '22', negative, keywords }, rt.ctx);
    await expect(call([{ text: 'cheap', match_type: 'BROAD', final_urls: ['https://shop.example'] }], true)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ text: 'cheap', match_type: 'BROAD', final_url_suffix: 'a=b' }], true)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ text: 'shoes', match_type: 'EXACT', final_urls: ['ftp://shop.example/file'] }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ text: 'shoes', match_type: 'EXACT', final_urls: ['https://user:secret@shop.example/'] }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ text: 'shoes', match_type: 'EXACT', final_mobile_urls: ['https://m.shop.example/'] }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toEqual([]);
    await expect(f.provider.previewWrite(op('google_add_keywords', { ad_group_id: '22', negative: true, keywords: [{ text: 'cheap', match_type: 'BROAD', final_urls: ['https://shop.example'] }] }, 'create'), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toEqual([]);
  });
});

describe('google_update_keyword_urls', () => {
  const payload = { keywords: [
    { ad_group_id: '22', criterion_id: '101', final_urls: ['https://shop.example/running'] },
    { ad_group_id: '33', criterion_id: '202', tracking_url_template: null, final_url_suffix: 'utm=new', final_urls: [] },
  ] };

  it('reads current values, then sends exact per-keyword masks and clears through the mask', async () => {
    const f = fixture(), preview = await f.provider.previewWrite(op('google_update_keyword_urls', payload), guard);
    const search = f.calls.find(call => call.url.pathname.endsWith('googleAds:search'))!;
    expect(search.body.query).toContain(`ad_group_criterion.resource_name IN ('${ROOT}/adGroupCriteria/22~101', '${ROOT}/adGroupCriteria/33~202')`);
    for (const field of ['final_urls', 'final_mobile_urls', 'tracking_url_template', 'final_url_suffix', 'negative', 'type']) expect(search.body.query).toContain(`ad_group_criterion.${field}`);
    expect(search.body.query).toContain('include_drafts=true');
    const [call] = mutations(f);
    expect(call!.url.pathname).toBe(`/v25/${ROOT}/adGroupCriteria:mutate`);
    expect(call!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [
      { update: { resourceName: `${ROOT}/adGroupCriteria/22~101`, finalUrls: ['https://shop.example/running'] }, updateMask: 'final_urls' },
      { update: { resourceName: `${ROOT}/adGroupCriteria/33~202`, finalUrlSuffix: 'utm=new' }, updateMask: 'final_urls,tracking_url_template,final_url_suffix' },
    ] });
    expect(preview.fieldChanges).toEqual([
      { field: '"running shoes" [EXACT] 22~101 final_urls', before: 'https://shop.example/old', after: 'https://shop.example/running' },
      { field: '"trail shoes" [EXACT] 33~202 final_urls', before: '(none)', after: '(cleared)' },
      { field: '"trail shoes" [EXACT] 33~202 tracking_url_template', before: '{lpurl}?src=old', after: '(cleared)' },
      { field: '"trail shoes" [EXACT] 33~202 final_url_suffix', before: 'utm=old', after: 'utm=new' },
    ]);
    expect(preview.summary).toBe('Update landing-page URLs on 2 keywords');
  });

  it('rejects negatives, non-keywords, missing criteria and orphan mobile URLs without mutating', async () => {
    const f = fixture({ criteria: [crit('22', '101', 'free', { negative: true }), { ...crit('22', '102', ''), type: 'AGE_RANGE' }, crit('22', '103', 'shoes')] });
    for (const keyword of [
      { ad_group_id: '22', criterion_id: '101', final_urls: ['https://shop.example'] },
      { ad_group_id: '22', criterion_id: '102', final_urls: ['https://shop.example'] },
      { ad_group_id: '22', criterion_id: '999', final_urls: ['https://shop.example'] },
      { ad_group_id: '22', criterion_id: '103', final_mobile_urls: ['https://m.shop.example'] },
    ]) await expect(f.provider.previewWrite(op('google_update_keyword_urls', { keywords: [keyword] }), guard)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mutations(f)).toEqual([]);
  });

  it('batches lookups in chunks of 200 and sends one mutate in input order', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => String(1000 + i)), criteria = ids.map(id => crit('22', id, `kw ${id}`));
    const f = fixture({ criteria }), keywords = ids.map(id => ({ ad_group_id: '22', criterion_id: id, final_url_suffix: `n=${id}` }));
    const preview = await f.provider.previewWrite(op('google_update_keyword_urls', { keywords }), guard);
    const searches = f.calls.filter(call => call.url.pathname.endsWith('googleAds:search'));
    expect(searches).toHaveLength(3);
    const lists = searches.map(call => [...String(call.body.query).matchAll(/'(customers\/[^']+)'/g)].map(match => match[1]));
    expect(lists.map(list => list.length)).toEqual([200, 200, 50]);
    expect(lists.flat()).toEqual(ids.map(id => `${ROOT}/adGroupCriteria/22~${id}`));
    const calls = mutations(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.operations).toHaveLength(450);
    expect((calls[0]!.body.operations as Row[]).map(item => item.update.resourceName)).toEqual(ids.map(id => `${ROOT}/adGroupCriteria/22~${id}`));
    expect(preview.summary).toBe('Update landing-page URLs on 450 keywords');
  });

  it('rejects a REMOVED keyword before any mutate call', async () => {
    const f = fixture({ criteria: [crit('22', '101', 'gone', { status: 'REMOVED' })] });
    await expect(f.provider.previewWrite(op('google_update_keyword_urls', { keywords: [{ ad_group_id: '22', criterion_id: '101', final_urls: ['https://shop.example'] }] }), guard))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('was not found') });
    expect(mutations(f)).toEqual([]);
  });

  it('rejects clearing final_urls while existing mobile URLs remain', async () => {
    const f = fixture({ criteria: [crit('22', '101', 'shoes', { finalUrls: ['https://shop.example'], finalMobileUrls: ['https://m.shop.example'] })] });
    await expect(f.provider.previewWrite(op('google_update_keyword_urls', { keywords: [{ ad_group_id: '22', criterion_id: '101', final_urls: [] }] }), guard))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('final_mobile_urls without final_urls') });
    expect(mutations(f)).toEqual([]);
    // Clearing both together is allowed.
    await f.provider.previewWrite(op('google_update_keyword_urls', { keywords: [{ ad_group_id: '22', criterion_id: '101', final_urls: [], final_mobile_urls: [] }] }), guard);
    expect(mutations(f)).toHaveLength(1);
  });

  it('validates the payload at the registry boundary', async () => {
    const f = fixture(), rt = await createContext({ providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const call = (keywords: Row[]) => rt.registry.call('google_update_keyword_urls', { account_id: A, keywords }, rt.ctx);
    await expect(call([{ ad_group_id: '22', criterion_id: '101' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ ad_group_id: '22', criterion_id: '101', final_urls: ['javascript:alert(1)'] }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call([{ ad_group_id: '22', criterion_id: '101', final_urls: ['https://a.example'] }, { ad_group_id: '22', criterion_id: '101', final_url_suffix: 'x=1' }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toEqual([]);
  });

  it('surfaces the Google error envelope from the dry run', async () => {
    const f = fixture({ mutateError: true });
    await expect(f.provider.previewWrite(op('google_update_keyword_urls', { keywords: [{ ad_group_id: '22', criterion_id: '101', tracking_url_template: '{bad}' }] }), guard))
      .rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('req-kw') });
  });

  it('rejects a mismatched apply receipt', async () => {
    const f = fixture({ receipt: names => names.slice(1) });
    await expect(f.provider.applyWrite(op('google_update_keyword_urls', payload), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('runs behind the policy gate: preview binds, apply mutates once', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>();
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
    const rt = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] }), args = { account_id: A, ...payload };
    const preview = await rt.registry.call('google_update_keyword_urls', args, rt.ctx) as { pending_operation_id: string };
    expect(mutations(f).every(call => call.body.validateOnly)).toBe(true);
    await expect(rt.registry.call('google_update_keyword_urls', { ...args, keywords: payload.keywords.slice(0, 1), pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await rt.registry.call('google_update_keyword_urls', { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx);
    expect(mutations(f).filter(call => call.body.validateOnly === false)).toHaveLength(1);
  });
});

describe('keyword URL reads', () => {
  it('returns keyword-level URLs through google_gaql on ad_group_criterion', async () => {
    const f = fixture(), rt = await createContext({ providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const result = await rt.registry.call('google_gaql', { customer_id: A, resource: 'ad_group_criterion', fields: ['ad_group_criterion.keyword.text', 'ad_group_criterion.final_urls'], conditions: ["ad_group_criterion.type = 'KEYWORD'"], limit: 10 }, rt.ctx) as Row;
    expect(f.calls[0]!.body.query).toBe("SELECT ad_group_criterion.keyword.text, ad_group_criterion.final_urls FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD' LIMIT 10 PARAMETERS omit_unselected_resource_names=true");
    expect(JSON.stringify(result)).toContain('https://shop.example/old');
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { WriteOperation } from '@adport/core';
import { XAdsClient, createXSigner, type XAdsCredentials } from '../src/client.js';
import { XAdsEntities } from '../src/entities.js';
import { accountSchema, campaignSchema, fundingSchema } from '../src/schemas.js';
import { planXWrite } from '../src/writes.js';

// Synthetic values with response shapes checked against X's official v12
// campaign-management/reference (2026-08-31). No live credentials or requests.
const credentials: XAdsCredentials = { consumerKey: 'synthetic-key', consumerSecret: 'synthetic-secret', accessToken: 'synthetic-token', accessTokenSecret: 'synthetic-token-secret' };
const account = { id: 'a1', name: 'Synthetic account', timezone: 'Europe/Berlin', timezone_switch_at: null, approval_status: 'ACCEPTED', deleted: false };
const campaign = { id: 'c1', name: 'Synthetic campaign', currency: 'EUR', funding_instrument_id: 'f1', entity_status: 'PAUSED', deleted: false, budget_optimization: 'LINE_ITEM', daily_budget_amount_local_micro: 10_000_001, total_budget_amount_local_micro: null };
const funding = { id: 'f1', account_id: 'a1', description: 'Synthetic funding', currency: 'EUR', type: 'CREDIT_CARD', entity_status: 'ACTIVE', able_to_fund: true, deleted: false };
type Call = { url: URL; init: RequestInit };
function fixture(handler: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), init }; calls.push(call);
    const result = handler(call); return result instanceof Response ? result : Response.json(result);
  };
  const client = new XAdsClient(credentials, fetchImpl);
  return { client, entities: new XAdsEntities(client), calls };
}
const percent = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function auth(call: Call): Record<string, string> {
  return Object.fromEntries(new Headers(call.init.headers).get('authorization')!.replace(/^OAuth /, '').split(', ').map(pair => {
    const split = pair.indexOf('='); return [decodeURIComponent(pair.slice(0, split)), decodeURIComponent(pair.slice(split + 2, -1))];
  }));
}
function verifySignature(call: Call) {
  const { oauth_signature: signature, ...oauth } = auth(call);
  const params = [...call.url.searchParams, ...Object.entries(oauth)].map(([k, v]) => [percent(k), percent(v)].join('=')).sort().join('&');
  const base = [call.init.method!, call.url.origin + call.url.pathname, params].map(percent).join('&');
  expect(signature).toBe(createHmac('sha1', `${percent(credentials.consumerSecret)}&${percent(credentials.accessTokenSecret)}`).update(base).digest('base64'));
}

describe('X OAuth 1.0a and safe transport', () => {
  it('matches the published OAuth 1.0 photo-request signature vector', () => {
    const creds = { consumerKey: 'dpf43f3p2l4k3l03', consumerSecret: 'kd94hf93k423kf44', accessToken: 'nnch734d00sl2jdk', accessTokenSecret: 'pfkkdhi9sl3r4s00' };
    const signer = createXSigner(creds);
    signer.getNonce = () => 'kllo9940pd9333jh'; signer.getTimeStamp = () => 1191242096;
    const signed = signer.authorize({ method: 'GET', url: 'http://photos.example.net/photos?file=vacation.jpg&size=original' }, { key: creds.accessToken, secret: creds.accessTokenSecret });
    expect(signed.oauth_signature).toBe('tR3+Ty81lMeYAr/Fid0kMTYa/WM=');
  });
  it.each(['GET', 'POST', 'PUT'] as const)('signs the exact %s query URL once with RFC3986 punctuation and Unicode', async method => {
    const { client, calls } = fixture(() => ({ data: campaign }));
    await client.request(method, 'accounts/a1/campaigns', z.object({ data: campaignSchema }), { name: "A + B & (C)! 'Ü'", daily_budget_amount_local_micro: 1_000_001, entity_status: 'PAUSED' });
    const call = calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe('https://ads-api.x.com/12/accounts/a1/campaigns');
    expect(call.url.searchParams.get('name')).toBe("A + B & (C)! 'Ü'");
    expect(call.init.body).toBeUndefined(); expect(call.init.redirect).toBe('error');
    expect(auth(call)).toMatchObject({ oauth_consumer_key: credentials.consumerKey, oauth_token: credentials.accessToken, oauth_signature_method: 'HMAC-SHA1', oauth_version: '1.0' });
    expect(call.url.href).not.toContain(credentials.accessToken); verifySignature(call);
  });
  it('generates a new cryptographic nonce per request, with Unix-second timestamps', async () => {
    const { client, calls } = fixture(() => ({}));
    await client.request('GET', 'accounts', z.object({})); await client.request('GET', 'accounts', z.object({}));
    expect(auth(calls[0]!).oauth_nonce).toMatch(/^[0-9a-f]{48}$/);
    expect(auth(calls[0]!).oauth_nonce).not.toBe(auth(calls[1]!).oauth_nonce);
    expect(Math.abs(Number(auth(calls[0]!).oauth_timestamp) - Date.now() / 1000)).toBeLessThan(5);
  });
  it.each(['https://evil.test', '//evil.test', '/accounts', 'accounts/../oauth', 'accounts?token=1', 'accounts/%2e%2e'])('rejects unsafe resource path %s before signing', async path => {
    const { client, calls } = fixture(() => ({}));
    await expect(client.request('GET', path, z.object({}))).rejects.toThrow('invalid API resource path'); expect(calls).toHaveLength(0);
  });
  it('rejects OAuth parameter injection and non-finite parameters', async () => {
    const { client, calls } = fixture(() => ({}));
    await expect(client.request('GET', 'accounts', z.object({}), { oauth_token: 'other' })).rejects.toThrow('invalid API parameter');
    await expect(client.request('GET', 'accounts', z.object({}), { count: Infinity })).rejects.toThrow('invalid API parameter'); expect(calls).toHaveLength(0);
  });
  it.each([401, 403, 429, 500])('does not replay an HTTP %s write or expose provider secrets', async status => {
    const { client, calls } = fixture(() => Response.json({ message: credentials.accessTokenSecret }, { status }));
    const error = await client.request('PUT', 'accounts/a1/campaigns/c1', z.object({})).catch(e => e);
    expect(error.message).toContain(`HTTP ${status}`); expect(error.message).toContain('not retried'); expect(error.message).not.toContain(credentials.accessTokenSecret); expect(calls).toHaveLength(1);
    if (status === 403) expect(error.message).toContain('app approval');
  });
  it('sanitizes transport exceptions and labels unknown write outcome', async () => {
    const { client, calls } = fixture(() => { throw new Error(credentials.consumerSecret); });
    const error = await client.request('POST', 'accounts/a1/campaigns', z.object({})).catch(e => e);
    expect(error.message).toContain('write outcome unknown'); expect(error.message).not.toContain(credentials.consumerSecret); expect(calls).toHaveLength(1);
  });
  it.each([{ errors: [{ code: 'BAD', message: 'secret' }], data: account }, { data: { id: 123 } }])('rejects HTTP-200 error envelopes and malformed response shapes', async data => {
    const { client } = fixture(() => data);
    await expect(client.request('GET', 'accounts/a1', z.object({ data: accountSchema }))).rejects.toThrow('x:');
  });
  it('rejects non-JSON success responses', async () => {
    const { client } = fixture(() => new Response('<html>private</html>'));
    await expect(client.request('GET', 'accounts', z.object({}))).rejects.toThrow('invalid JSON');
  });
  it('rejects missing or blank OAuth credentials before any request', () => {
    for (const key of Object.keys(credentials)) expect(() => new XAdsClient({ ...credentials, [key]: ' ' })).toThrow('four OAuth');
  });
});

describe('X entity response contracts', () => {
  it('discovers cursor-paginated accounts without inventing a currency', async () => {
    const { entities, calls } = fixture(({ url }) => ({ data: [{ ...account, id: url.searchParams.has('cursor') ? 'a2' : 'a1' }], next_cursor: url.searchParams.has('cursor') ? null : 'next+&=' }));
    expect(await entities.listAccounts()).toEqual(['a1', 'a2'].map(id => ({ provider: 'x', id, name: account.name, status: 'ACCEPTED' })));
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('next+&='); expect(calls[1]!.url.searchParams.has('with_total_count')).toBe(false); verifySignature(calls[1]!);
  });
  it('fails closed on repeated cursors or repeated IDs', async () => {
    let count = 0;
    const looping = fixture(() => ({ data: [{ ...account, id: `a${++count}` }], next_cursor: 'same' }));
    await expect(looping.entities.listAccounts()).rejects.toThrow('did not terminate');
    const duplicate = fixture(() => ({ data: [account], next_cursor: 'same' }));
    await expect(duplicate.entities.listAccounts()).rejects.toThrow('repeated an entity');
  });
  it('includes deleted and draft campaigns for historical reports', async () => {
    const { entities, calls } = fixture(() => ({ data: [campaign], next_cursor: null }));
    expect(await entities.listCampaigns('a1')).toEqual([campaign]);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ count: '200', with_deleted: 'true', with_draft: 'true' });
  });
  it('validates single account and campaign IDs', async () => {
    const wrongAccount = fixture(() => ({ data: { ...account, id: 'a2' } }));
    await expect(wrongAccount.entities.getAccount('a1')).rejects.toThrow('ID mismatch');
    const wrongCampaign = fixture(() => ({ data: { ...campaign, id: 'c2' } }));
    await expect(wrongCampaign.entities.getCampaign('a1', 'c1')).rejects.toThrow('ID mismatch');
  });
  it('preserves integer account-currency micros and nullable budgets', () => {
    expect(campaignSchema.parse(campaign).daily_budget_amount_local_micro).toBe(10_000_001);
    expect(campaignSchema.safeParse({ ...campaign, daily_budget_amount_local_micro: '10' }).success).toBe(false);
    expect(campaignSchema.safeParse({ ...campaign, daily_budget_amount_local_micro: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });
  it('checks funding instrument account ownership in lists and single responses', async () => {
    const list = fixture(() => ({ data: [{ ...funding, account_id: 'a2' }] }));
    await expect(list.entities.listFundingInstruments('a1')).rejects.toThrow('account mismatch');
    const single = fixture(() => ({ data: { ...funding, id: 'f2' } }));
    await expect(single.entities.getFundingInstrument('a1', 'f1')).rejects.toThrow('account/ID mismatch');
    expect(fundingSchema.parse(funding).currency).toBe('EUR');
  });
  it('reads line items and promoted-tweet references without coercing tweet snowflakes to numbers', async () => {
    const tweet = { id: 'p1', line_item_id: 'l1', tweet_id: '880290790664060928', entity_status: 'ACTIVE', deleted: false };
    const line = { id: 'l1', name: 'Line item', campaign_id: 'c1', currency: 'EUR', entity_status: 'PAUSED', deleted: false, placements: ['ALL_ON_TWITTER'], product_type: 'PROMOTED_TWEETS', objective: 'ENGAGEMENTS' };
    const { entities, calls } = fixture(({ url }) => ({ data: [url.pathname.endsWith('line_items') ? line : tweet], next_cursor: null }));
    expect(await entities.listLineItems('a1')).toEqual([line]); expect(await entities.listPromotedTweets('a1')).toEqual([tweet]);
    expect(calls[1]!.url.searchParams.has('with_draft')).toBe(false); expect(calls[1]!.url.searchParams.get('with_deleted')).toBe('true');
  });
});

const createOp: WriteOperation = { provider: 'x', accountId: 'a1', tool: 'x_create_campaign', kind: 'create', payload: { name: 'New & paused', funding_instrument_id: 'f1', daily_budget_micros: 20_000_001, status: 'ACTIVE' } };
const budgetOp: WriteOperation = { provider: 'x', accountId: 'a1', tool: 'x_set_budget', kind: 'update', payload: { campaign_id: 'c1', budget_type: 'DAILY', budget_micros: 11_000_001 } };
const pauseOp: WriteOperation = { provider: 'x', accountId: 'a1', tool: 'x_set_campaign_status', kind: 'update', payload: { campaign_id: 'c1', status: 'PAUSED' } };
const guard = { forcePausedCreation: true };
describe('X campaign write plans', () => {
  it('previews with reads only, reports paused coercion and micros, and creates with explicit PAUSED', async () => {
    const { entities, calls } = fixture(({ init }) => ({ data: init.method === 'GET' ? funding : { ...campaign, name: createOp.payload.name, daily_budget_amount_local_micro: 20_000_001 } }));
    const plan = await planXWrite(entities, createOp, guard);
    expect(calls.every(c => c.init.method === 'GET')).toBe(true);
    expect(plan.coercions).toEqual(['status coerced to PAUSED by policy (paused_creation)']);
    expect(plan.budgetDeltas).toEqual([{ target: 'new campaign daily budget', toMicros: 20_000_001 }]);
    expect(await plan.execute()).toEqual(['c1']);
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ name: 'New & paused', funding_instrument_id: 'f1', budget_optimization: 'LINE_ITEM', entity_status: 'PAUSED', daily_budget_amount_local_micro: '20000001' });
    expect(calls[1]!.init.method).toBe('POST'); verifySignature(calls[1]!);
  });
  it('reports both daily and total caps on creation', async () => {
    const { entities } = fixture(() => ({ data: funding }));
    const plan = await planXWrite(entities, { ...createOp, payload: { ...createOp.payload, total_budget_micros: 100_000_000 } }, guard);
    expect(plan.budgetDeltas).toHaveLength(2); expect(plan.budgetDeltas[1]!.toMicros).toBe(100_000_000);
  });
  it.each([{ deleted: true }, { able_to_fund: false }, { entity_status: 'PAUSED' }])('rejects unusable funding %j', async overrides => {
    const { entities, calls } = fixture(() => ({ data: { ...funding, ...overrides } }));
    await expect(planXWrite(entities, createOp, guard)).rejects.toThrow('cannot fund'); expect(calls).toHaveLength(1);
  });
  it('rejects daily > total before any provider call', async () => {
    const { entities, calls } = fixture(() => ({}));
    await expect(planXWrite(entities, { ...createOp, payload: { ...createOp.payload, total_budget_micros: 10 } }, guard)).rejects.toThrow('cannot exceed'); expect(calls).toHaveLength(0);
  });
  it('changes only the approved daily budget and preserves total cap and status', async () => {
    const { entities, calls } = fixture(({ init }) => ({ data: { ...campaign, total_budget_amount_local_micro: 100_000_000, ...(init.method === 'PUT' ? { daily_budget_amount_local_micro: 11_000_001 } : {}) } }));
    const plan = await planXWrite(entities, budgetOp, guard);
    expect(plan.budgetDeltas).toEqual([{ target: 'campaign c1 daily budget', fromMicros: 10_000_001, toMicros: 11_000_001 }]);
    await plan.execute(); expect(calls[1]!.init.method).toBe('PUT');
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ daily_budget_amount_local_micro: '11000001' });
  });
  it('changes an existing total cap without changing daily budget', async () => {
    const { entities, calls } = fixture(({ init }) => ({ data: { ...campaign, total_budget_amount_local_micro: init.method === 'PUT' ? 110_000_000 : 100_000_000 } }));
    const plan = await planXWrite(entities, { ...budgetOp, payload: { ...budgetOp.payload, budget_type: 'TOTAL', budget_micros: 110_000_000 } }, guard);
    await plan.execute(); expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ total_budget_amount_local_micro: '110000000' });
  });
  it('does not invent an existing budget or allow caps below the daily budget', async () => {
    const missing = fixture(() => ({ data: campaign }));
    await expect(planXWrite(missing.entities, { ...budgetOp, payload: { ...budgetOp.payload, budget_type: 'TOTAL' } }, guard)).rejects.toThrow('no existing budget');
    const capped = fixture(() => ({ data: { ...campaign, total_budget_amount_local_micro: 10_000_001 } }));
    await expect(planXWrite(capped.entities, budgetOp, guard)).rejects.toThrow('cannot exceed');
  });
  it('changes only status for pause, without budget or deprecated delivery parameters', async () => {
    const { entities, calls } = fixture(({ init }) => ({ data: { ...campaign, entity_status: init.method === 'GET' ? 'ACTIVE' : 'PAUSED' } }));
    const plan = await planXWrite(entities, pauseOp, guard);
    expect(plan.budgetDeltas).toEqual([]); await plan.execute();
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toEqual({ entity_status: 'PAUSED' });
  });
  it.each([{ deleted: true }, { entity_status: 'DRAFT' }])('does not update unsupported campaign state %j', async overrides => {
    const { entities } = fixture(() => ({ data: { ...campaign, ...overrides } }));
    await expect(planXWrite(entities, pauseOp, guard)).rejects.toThrow('cannot be changed');
  });
  it.each([{ entity_status: 'ACTIVE' }, { currency: 'USD' }, { funding_instrument_id: 'f2' }, { daily_budget_amount_local_micro: 99 }])('rejects unexpected creation result %j without retrying', async overrides => {
    const { entities, calls } = fixture(({ init }) => ({ data: init.method === 'GET' ? funding : { ...campaign, name: createOp.payload.name, daily_budget_amount_local_micro: 20_000_001, ...overrides } }));
    const plan = await planXWrite(entities, createOp, guard);
    await expect(plan.execute()).rejects.toThrow('does not match'); expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1);
  });
  it('detects an update that unexpectedly reset another budget', async () => {
    const { entities } = fixture(({ init }) => ({ data: { ...campaign, total_budget_amount_local_micro: init.method === 'GET' ? 100_000_000 : null, daily_budget_amount_local_micro: init.method === 'GET' ? 10_000_001 : 11_000_001 } }));
    await expect((await planXWrite(entities, budgetOp, guard)).execute()).rejects.toThrow('does not match');
  });
  it('rejects the wrong provider and unknown write paths', async () => {
    const { entities, calls } = fixture(() => ({}));
    await expect(planXWrite(entities, { ...pauseOp, provider: 'meta' }, guard)).rejects.toThrow('provider mismatch');
    await expect(planXWrite(entities, { ...pauseOp, kind: 'remove' }, guard)).rejects.toThrow('unsupported write'); expect(calls).toHaveLength(0);
  });
});

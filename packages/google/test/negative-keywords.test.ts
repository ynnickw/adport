import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';
import { dedupeKeywords, formatKeyword, NEGATIVE_KEYWORD_MUTATE_BATCH } from '../src/negative-keywords.js';

// Google Ads API v25 reference, checked 2026-11-25 on developers.google.com/google-ads/api/reference/rpc/v25/:
// SharedSet (type NEGATIVE_KEYWORDS, status ENABLED/REMOVED, output-only member_count/reference_count),
// SharedCriterion (customers/{c}/sharedCriteria/{set}~{criterion}, create/remove only, KeywordInfo text ≤80 chars),
// CampaignSharedSet (customers/{c}/campaignSharedSets/{campaign}~{set}, create/remove only), CampaignCriterion
// negative keyword, MutateOperation shared_set_operation/shared_criterion_operation/campaign_shared_set_operation
// and their *_result responses, negative temporary resource names. Limits: 10,000 operations per mutate
// request (mutating best practices), 5,000 keywords per list and 10,000 negative keywords per campaign
// (Google Ads Help answer 6372658). The Help page's 20 lists per account is left to the validate_only
// dry run, like channel-specific caps. Fixtures are synthetic; no live API calls.
type Row = Record<string, any>;
const A = '1234567890', ROOT = `customers/${A}`, guard = { forcePausedCreation: true };
const list = (id: string, name: string, memberCount = 0, referenceCount = 0) => ({ resourceName: `${ROOT}/sharedSets/${id}`, id, name, type: 'NEGATIVE_KEYWORDS', status: 'ENABLED', memberCount: String(memberCount), referenceCount: String(referenceCount) });
const campaign = (id: string, name: string, status = 'ENABLED') => ({ resourceName: `${ROOT}/campaigns/${id}`, id, name, status, advertisingChannelType: 'SEARCH' });
const kw = (text: string, match_type: 'EXACT' | 'PHRASE' | 'BROAD' = 'BROAD') => ({ text, match_type });

function fixture() {
  const state = {
    lists: [list('501', 'Brand exclusions', 2, 1)] as Row[],
    criteria: [{ set: '501', id: '9001', text: 'free', matchType: 'BROAD' }, { set: '501', id: '9002', text: 'jobs', matchType: 'PHRASE' }] as Row[],
    links: [{ campaign: '11', set: '501' }] as Row[],
    campaigns: [campaign('11', 'Search FR'), campaign('12', 'Search BE', 'PAUSED'), campaign('13', 'Search CH')] as Row[],
    campaignNegatives: [{ campaign: '12', id: '7001', text: 'Cheap', matchType: 'EXACT' }] as Row[],
    response: undefined as undefined | ((url: string, body: Row) => Response | undefined),
    fail: undefined as undefined | ((url: string, body: Row) => boolean),
    receipt: undefined as undefined | ((url: string, response: Row) => Row),
    inventoryReads: { active: 0, peak: 0 },
  };
  const calls: Array<{ url: string; method: string; body: Row; headers: Row }> = [];
  let next = 100000;
  const client = new GoogleAdsRestClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert' }, 'v25', async (raw, init = {}) => {
    const url = String(raw);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'inert', expires_in: 3600 });
    const body = JSON.parse(String(init.body ?? '{}')) as Row;
    calls.push({ url, method: String(init.method), body, headers: init.headers as Row });
    const override = state.response?.(url, body);
    if (override) return override;
    if (state.fail?.(url, body)) return Response.json({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', errors: [{ errorCode: { criterionError: 'KEYWORD_HAS_INVALID_CHARS' }, message: 'Keyword text has invalid characters.', location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }, { fieldName: 'create' }] } }], requestId: 'req-1' }] } }, { status: 400 });
    if (url.endsWith('/googleAds:search')) {
      const query = String(body.query), from = query.match(/ FROM (\w+) /)![1];
      if (from === 'shared_set') { const only = query.match(/shared_set\.id = (\d+)/)?.[1]; return Response.json({ results: state.lists.filter(row => !only || row.id === only).map(sharedSet => ({ sharedSet })) }); }
      if (from === 'shared_criterion') { const set = query.match(/sharedSets\/(\d+)'/)![1]; return Response.json({ results: state.criteria.filter(row => row.set === set).map(row => ({ sharedCriterion: { resourceName: `${ROOT}/sharedCriteria/${row.set}~${row.id}`, sharedSet: `${ROOT}/sharedSets/${row.set}`, criterionId: row.id, type: 'KEYWORD', keyword: { text: row.text, matchType: row.matchType } } })) }); }
      if (from === 'campaign_shared_set') return Response.json({ results: state.links.filter(row => query.includes(`'${ROOT}/sharedSets/${row.set}'`)).map(row => ({ campaignSharedSet: { resourceName: `${ROOT}/campaignSharedSets/${row.campaign}~${row.set}`, campaign: `${ROOT}/campaigns/${row.campaign}`, sharedSet: `${ROOT}/sharedSets/${row.set}`, status: 'ENABLED' }, campaign: (({ id, name, status }) => ({ id, name, status }))(state.campaigns.find(value => value.id === row.campaign)!) })) });
      if (from === 'campaign') { const ids = query.match(/campaign\.id IN \(([^)]+)\)/)![1]!.split(', '); return Response.json({ results: state.campaigns.filter(row => ids.includes(row.id)).map(row => ({ campaign: row })) }); }
      if (from === 'campaign_criterion') { const reads = state.inventoryReads; reads.peak = Math.max(reads.peak, ++reads.active); await new Promise(resolve => setTimeout(resolve, 1)); reads.active--; }
      if (from === 'campaign_criterion') { const id = query.match(/campaign\.id = (\d+)/)![1]; return Response.json({ results: state.campaignNegatives.filter(row => row.campaign === id).map(row => ({ campaign: { id }, campaignCriterion: { resourceName: `${ROOT}/campaignCriteria/${id}~${row.id}`, campaign: `${ROOT}/campaigns/${id}`, criterionId: row.id, negative: true, keyword: { text: row.text, matchType: row.matchType } } })) }); }
      throw new Error(`Unexpected query ${query}`);
    }
    expect(body.partialFailure).toBe(false);
    if (body.validateOnly) return Response.json({});
    const reply = (response: Row) => Response.json(state.receipt ? state.receipt(url, response) : response);
    if (url.endsWith('/googleAds:mutate')) {
      let created = '';
      return reply({ mutateOperationResponses: body.mutateOperations.map((operation: Row) => {
        if (operation.sharedSetOperation) { const id = String(next++); state.lists.push(list(id, operation.sharedSetOperation.create.name)); created = id; return { sharedSetResult: { resourceName: `${ROOT}/sharedSets/${id}` } }; }
        const id = String(next++); state.criteria.push({ set: created, id, text: operation.sharedCriterionOperation.create.keyword.text, matchType: operation.sharedCriterionOperation.create.keyword.matchType });
        return { sharedCriterionResult: { resourceName: `${ROOT}/sharedCriteria/${created}~${id}` } };
      }) });
    }
    const service = url.match(/\/(\w+):mutate$/)![1];
    return reply({ results: body.operations.map((operation: Row) => {
      if (operation.remove) return { resourceName: operation.remove };
      const create = operation.create, id = String(next++);
      if (service === 'sharedCriteria') { const set = create.sharedSet.split('/').at(-1); state.criteria.push({ set, id, text: create.keyword.text, matchType: create.keyword.matchType }); return { resourceName: `${ROOT}/sharedCriteria/${set}~${id}` }; }
      if (service === 'campaignSharedSets') return { resourceName: `${ROOT}/campaignSharedSets/${create.campaign.split('/').at(-1)}~${create.sharedSet.split('/').at(-1)}` };
      return { resourceName: `${ROOT}/campaignCriteria/${create.campaign.split('/').at(-1)}~${id}` };
    }) });
  });
  return { state, calls, provider: new GoogleAdsProvider(client) };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind']): WriteOperation => ({ provider: 'google', tool, accountId: A, kind, payload });
const mutates = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.endsWith(':mutate'));
const base = `https://googleads.googleapis.com/v25/${ROOT}`;

describe('Google negative keyword tools', () => {
  it('registers lean read and guarded write tools with bounded keyword schemas', () => {
    const tools = googleTools(new Proxy({} as GoogleAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    const names = ['google_negative_keyword_lists', 'google_create_negative_keyword_list', 'google_update_negative_keyword_list', 'google_link_negative_keyword_list', 'google_add_campaign_negative_keywords'];
    expect(tools.filter(tool => tool.name.includes('negative_keyword')).map(tool => tool.name).sort()).toEqual([...names].sort());
    for (const name of names.slice(1)) expect(tools.find(tool => tool.name === name)!.input.shape.pending_operation_id, name).toBeDefined();
    const create = tools.find(tool => tool.name === 'google_create_negative_keyword_list')!.input;
    expect(create.safeParse({ account_id: A, name: 'List', keywords: [kw('free')] }).success).toBe(true);
    for (const payload of [{ name: '', keywords: [kw('free')] }, { name: 'List', keywords: [] }, { name: 'List', keywords: [kw('a'.repeat(81))] }, { name: 'List', keywords: [{ text: 'x', match_type: 'BROAD_MODIFIER' }] }, { name: 'List', keywords: Array.from({ length: 5001 }, (_, i) => kw(`k${i}`)) }, { name: 'List', keywords: [kw('x')], campaign_ids: ['0'] }]) expect(create.safeParse({ account_id: A, ...payload }).success).toBe(false);
    expect(tools.find(tool => tool.name === 'google_update_negative_keyword_list')!.input.safeParse({ account_id: A, shared_set_id: '501' }).success).toBe(false);
    const link = tools.find(tool => tool.name === 'google_link_negative_keyword_list')!.input;
    expect(link.safeParse({ account_id: A, shared_set_id: '501', action: 'detach', campaign_ids: ['11'] }).success).toBe(true);
    for (const action of [undefined, 'remove']) expect(link.safeParse({ account_id: A, shared_set_id: '501', action, campaign_ids: ['11'] }).success, String(action)).toBe(false);
  });

  it('deduplicates by text and match type ignoring case and whitespace, and formats Google notation', () => {
    expect(dedupeKeywords([kw('Free'), kw(' free '), kw('free', 'EXACT'), kw('free  trial'), kw('Free Trial')])).toEqual({ unique: [kw('Free'), kw('free', 'EXACT'), kw('free trial')], duplicates: [kw('free'), kw('Free Trial')] });
    expect([kw('a', 'EXACT'), kw('a', 'PHRASE'), kw('a')].map(formatKeyword)).toEqual(['[a]', '"a"', 'a']);
  });

  it('reads lists with counts and attached campaigns, and one list with its keywords, without writes', async () => {
    const f = fixture();
    expect(await f.provider.negativeKeywords.listLists({ account_id: A })).toEqual({ lists: [{ id: '501', name: 'Brand exclusions', member_count: 2, reference_count: 1, campaigns: [{ id: '11', name: 'Search FR', status: 'ENABLED' }] }] });
    expect(f.calls[0]).toMatchObject({ url: `${base}/googleAds:search`, method: 'POST' });
    expect(f.calls[0]!.body.query).toBe("SELECT shared_set.resource_name, shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, shared_set.reference_count FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED' ORDER BY shared_set.id ASC LIMIT 1001");
    expect(f.calls[1]!.body.query).toContain(`FROM campaign_shared_set WHERE campaign_shared_set.shared_set IN ('${ROOT}/sharedSets/501') AND campaign_shared_set.status = 'ENABLED'`);
    expect(f.calls.some(call => call.body.query?.includes('FROM shared_criterion'))).toBe(false);
    const context = await f.provider.negativeKeywords.listLists({ account_id: A, shared_set_id: '501', limit: 1 });
    expect(context).toEqual({ lists: [{ id: '501', name: 'Brand exclusions', member_count: 2, reference_count: 1, campaigns: [{ id: '11', name: 'Search FR', status: 'ENABLED' }], keywords: [{ criterion_id: '9001', text: 'free', match_type: 'BROAD' }], truncated: true }] });
    expect(f.calls.filter(call => call.body.query?.includes('FROM shared_set ')).at(-1)!.body.query).toContain('AND shared_set.id = 501 ');
    expect(f.calls.find(call => call.body.query?.includes('FROM shared_criterion'))!.body.query).toContain(`WHERE shared_criterion.shared_set = '${ROOT}/sharedSets/501' AND shared_criterion.type = 'KEYWORD'`);
    expect((await f.provider.negativeKeywords.listLists({ account_id: A, shared_set_id: '501' })).lists[0]).toMatchObject({ keywords: [{ criterion_id: '9001' }, { criterion_id: '9002', text: 'jobs', match_type: 'PHRASE' }], truncated: false });
    await expect(f.provider.negativeKeywords.listLists({ account_id: A, shared_set_id: '999' })).rejects.toThrow('not found');
    f.state.lists[0]!.resourceName = 'customers/9999999999/sharedSets/501';
    await expect(f.provider.negativeKeywords.listLists({ account_id: A })).rejects.toThrow('invalid identity');
    expect(mutates(f)).toEqual([]);
  });

  it('creates a list with deduplicated keywords atomically, then attaches campaigns, after a native dry run', async () => {
    const f = fixture(), operation = op('google_create_negative_keyword_list', { name: 'Competitors', keywords: [kw('acme', 'EXACT'), kw('Acme', 'EXACT'), kw('acme pricing', 'PHRASE')], campaign_ids: ['11', '12'] }, 'create');
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ serverValidated: true, coercions: [], budgetDeltas: [], summary: 'Create Google negative keyword list “Competitors” with 2 keywords and attach it to 2 campaigns', review: { kind: 'create', fields: [{ label: 'List name', after: 'Competitors' }, { label: 'Negative keywords (2)', after: ['[acme]', '"acme pricing"'] }, { label: 'Skipped duplicates (1)', after: ['[Acme]'] }, { label: 'Attach to campaigns (2)', after: ['Search FR (11, ENABLED)', 'Search BE (12, PAUSED)'] }] } });
    const temp = `${ROOT}/sharedSets/-1`, createSet = { sharedSetOperation: { create: { resourceName: temp, name: 'Competitors', type: 'NEGATIVE_KEYWORDS' } } };
    expect(mutates(f).map(call => [call.url, call.body])).toEqual([
      [`${base}/googleAds:mutate`, { mutateOperations: [createSet, { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: 'acme', matchType: 'EXACT' } } } }, { sharedCriterionOperation: { create: { sharedSet: temp, keyword: { text: 'acme pricing', matchType: 'PHRASE' } } } }], validateOnly: true, partialFailure: false }],
      [`${base}/googleAds:mutate`, { mutateOperations: [createSet, { campaignSharedSetOperation: { create: { campaign: `${ROOT}/campaigns/11`, sharedSet: temp } } }, { campaignSharedSetOperation: { create: { campaign: `${ROOT}/campaigns/12`, sharedSet: temp } } }], validateOnly: true, partialFailure: false }],
    ]);
    f.calls.length = 0;
    const result = await f.provider.applyWrite(operation, guard);
    const writes = mutates(f).filter(call => !call.body.validateOnly);
    expect(writes.map(call => call.url)).toEqual([`${base}/googleAds:mutate`, `${base}/campaignSharedSets:mutate`]);
    expect(writes[0]!.body.mutateOperations).toHaveLength(3);
    expect(writes[1]!.body).toEqual({ operations: [{ create: { campaign: `${ROOT}/campaigns/11`, sharedSet: `${ROOT}/sharedSets/100000` } }, { create: { campaign: `${ROOT}/campaigns/12`, sharedSet: `${ROOT}/sharedSets/100000` } }], validateOnly: false, partialFailure: false });
    expect(result).toEqual({ applied: true, resourceIds: [`${ROOT}/sharedSets/100000`, `${ROOT}/sharedCriteria/100000~100001`, `${ROOT}/sharedCriteria/100000~100002`, `${ROOT}/campaignSharedSets/11~100000`, `${ROOT}/campaignSharedSets/12~100000`], details: { shared_set_id: '100000', keywords_added: 2, skipped_duplicates: 1, campaigns_attached: ['11', '12'] } });
  });

  it('batches hundreds of keywords within the per-request operation bound', async () => {
    const f = fixture(), keywords = Array.from({ length: 2500 }, (_, i) => kw(`term ${i}`, 'PHRASE'));
    const operation = op('google_create_negative_keyword_list', { name: 'Bulk', keywords }, 'create');
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview.review!.fields[1]).toEqual({ label: 'Negative keywords (2500)', after: [...keywords.slice(0, 10).map(value => `"${value.text}"`), '… and 2490 more'] });
    expect(preview.changes.join('\n').length).toBeLessThan(2000);
    expect(mutates(f).map(call => call.body.mutateOperations.length)).toEqual([1000, 1000, 503]);
    f.calls.length = 0;
    await f.provider.applyWrite(operation, guard);
    const writes = mutates(f).filter(call => !call.body.validateOnly);
    expect(writes.map(call => [call.url.split('/').at(-1), (call.body.mutateOperations ?? call.body.operations).length])).toEqual([['googleAds:mutate', 1000], ['sharedCriteria:mutate', 1000], ['sharedCriteria:mutate', 501]]);
    expect(writes.every(call => (call.body.mutateOperations ?? call.body.operations).length <= NEGATIVE_KEYWORD_MUTATE_BATCH)).toBe(true);
    expect(f.state.criteria.filter(row => row.set === '100000')).toHaveLength(2500);
  });

  it('rejects duplicate list names ignoring case and unknown campaigns before any mutate, leaving the list count to the dry run', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(op('google_create_negative_keyword_list', { name: 'Brand exclusions', keywords: [kw('x')] }, 'create'), guard)).rejects.toThrow('already exists');
    await expect(f.provider.previewWrite(op('google_create_negative_keyword_list', { name: 'BRAND Exclusions', keywords: [kw('x')] }, 'create'), guard)).rejects.toThrow('already exists');
    await expect(f.provider.previewWrite(op('google_create_negative_keyword_list', { name: 'New', keywords: [kw('x')], campaign_ids: ['11', '404'] }, 'create'), guard)).rejects.toThrow('not found or removed in the selected account: 404');
    await expect(f.provider.previewWrite(op('google_create_negative_keyword_list', { name: 'New', keywords: [kw('x')] }, 'update'), guard)).rejects.toThrow('kind mismatch');
    expect(mutates(f)).toEqual([]);
    f.state.lists = Array.from({ length: 20 }, (_, i) => list(String(600 + i), `List ${i}`));
    expect(await f.provider.previewWrite(op('google_create_negative_keyword_list', { name: 'New', keywords: [kw('x')] }, 'create'), guard)).toMatchObject({ serverValidated: true });
    expect(mutates(f).every(call => call.body.validateOnly === true)).toBe(true);
  });

  it('keeps the new list id and finish guidance when a create receipt cannot be confirmed', async () => {
    const f = fixture();
    f.state.receipt = (url, response) => url.endsWith('/googleAds:mutate') ? { mutateOperationResponses: [response.mutateOperationResponses[0], { sharedCriterionResult: { resourceName: `${ROOT}/sharedCriteria/999~1` } }] } : response;
    const error = await f.provider.applyWrite(op('google_create_negative_keyword_list', { name: 'Competitors', keywords: [kw('acme')], campaign_ids: ['11'] }, 'create'), guard).catch(value => value);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('stopped after 1 of 3 confirmed operations. A request of 1 operation was sent but its receipt could not be confirmed'), details: { resourceIds: [`${ROOT}/sharedSets/100000`], shared_set_id: '100000', unconfirmed_operations: 1 } });
    expect(error.message).toContain('List 100000 exists; finish with google_update_negative_keyword_list');
    expect(mutates(f).filter(call => !call.body.validateOnly).map(call => call.url)).toEqual([`${base}/googleAds:mutate`]);
  });

  it('reports the list id and confirmed resources when a later create batch fails or is unconfirmed', async () => {
    const f = fixture(), keywords = Array.from({ length: 1500 }, (_, i) => kw(`k${i}`));
    f.state.fail = (url, body) => url.endsWith('/sharedCriteria:mutate') && !body.validateOnly;
    const error = await f.provider.applyWrite(op('google_create_negative_keyword_list', { name: 'Bulk', keywords }, 'create'), guard).catch(value => value);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('stopped after 1000 of 1501 confirmed operations'), details: { shared_set_id: '100000' } });
    expect(error.message).toContain('List 100000 exists');
    expect(error.details.resourceIds).toHaveLength(1000);
    expect(error.details.resourceIds[0]).toBe(`${ROOT}/sharedSets/100000`);
    const g = fixture();
    g.state.receipt = (url, response) => url.endsWith('/campaignSharedSets:mutate') ? { results: [] } : response;
    const unconfirmed = await g.provider.applyWrite(op('google_create_negative_keyword_list', { name: 'Linked', keywords: [kw('x')], campaign_ids: ['11', '13'] }, 'create'), guard).catch(value => value);
    expect(unconfirmed).toMatchObject({ details: { shared_set_id: '100000', unconfirmed_operations: 2, resourceIds: [`${ROOT}/sharedSets/100000`, `${ROOT}/sharedCriteria/100000~100001`] }, message: expect.stringContaining('A request of 2 operations was sent but its receipt could not be confirmed') });
  });

  it('adds and removes list keywords in bulk, skipping existing, duplicate and missing keywords', async () => {
    const f = fixture(), operation = op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: [kw('FREE'), kw('torrent'), kw('Torrent'), kw('crack', 'EXACT')], remove_keywords: [kw('jobs', 'PHRASE'), kw('careers', 'PHRASE')] }, 'update');
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview.review!.fields).toEqual([{ label: 'List', after: 'Brand exclusions (501)' }, { label: 'Keywords', before: 2, after: 3 }, { label: 'Add (2)', after: ['torrent', '[crack]'] }, { label: 'Remove (1)', after: ['"jobs"'] }, { label: 'Skipped, already in list (1)', after: ['FREE'] }, { label: 'Skipped duplicates (1)', after: ['Torrent'] }, { label: 'Skipped, not in list (1)', after: ['"careers"'] }]);
    const expected = { operations: [{ create: { sharedSet: `${ROOT}/sharedSets/501`, keyword: { text: 'torrent', matchType: 'BROAD' } } }, { create: { sharedSet: `${ROOT}/sharedSets/501`, keyword: { text: 'crack', matchType: 'EXACT' } } }, { remove: `${ROOT}/sharedCriteria/501~9002` }], partialFailure: false };
    expect(mutates(f).map(call => [call.url, call.body])).toEqual([[`${base}/sharedCriteria:mutate`, { ...expected, validateOnly: true }]]);
    f.calls.length = 0;
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [`${ROOT}/sharedCriteria/501~100000`, `${ROOT}/sharedCriteria/501~100001`, `${ROOT}/sharedCriteria/501~9002`], details: { added: 2, removed: 1, skipped_already_present: 1, skipped_duplicates: 1, skipped_not_found: 1 } });
    expect(mutates(f).at(-1)!.body).toEqual({ ...expected, validateOnly: false });
    await expect(f.provider.previewWrite(op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: [kw('free')] }, 'update'), guard)).rejects.toThrow('nothing to change');
    await expect(f.provider.previewWrite(op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: [kw('x')], remove_keywords: [kw('X')] }, 'update'), guard)).rejects.toThrow('both added and removed');
    f.state.criteria = Array.from({ length: 4999 }, (_, i) => ({ set: '501', id: String(20000 + i), text: `t${i}`, matchType: 'BROAD' }));
    await expect(f.provider.previewWrite(op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: [kw('a'), kw('b')] }, 'update'), guard)).rejects.toThrow('at most 5000 keywords');
  });

  it('attaches and detaches a list across campaigns, skipping campaigns already in the requested state', async () => {
    const f = fixture(), link = op('google_link_negative_keyword_list', { shared_set_id: '501', action: 'attach', campaign_ids: ['11', '12', '13'] }, 'update');
    expect(await f.provider.previewWrite(link, guard)).toMatchObject({ summary: 'Attach Google negative keyword list “Brand exclusions” to 2 campaigns', review: { kind: 'create', fields: [{}, { label: 'Attach campaigns (2)', after: ['Search BE (12, PAUSED)', 'Search CH (13, ENABLED)'] }, { label: 'Skipped, already attached (1)', after: ['Search FR (11, ENABLED)'] }] } });
    expect(mutates(f)[0]).toMatchObject({ url: `${base}/campaignSharedSets:mutate`, body: { operations: [{ create: { campaign: `${ROOT}/campaigns/12`, sharedSet: `${ROOT}/sharedSets/501` } }, { create: { campaign: `${ROOT}/campaigns/13`, sharedSet: `${ROOT}/sharedSets/501` } }], validateOnly: true } });
    expect((await f.provider.applyWrite(link, guard)).resourceIds).toEqual([`${ROOT}/campaignSharedSets/12~501`, `${ROOT}/campaignSharedSets/13~501`]);
    f.calls.length = 0;
    const unlink = op('google_link_negative_keyword_list', { shared_set_id: '501', action: 'detach', campaign_ids: ['11', '13'] }, 'update');
    expect(await f.provider.previewWrite(unlink, guard)).toMatchObject({ summary: 'Detach Google negative keyword list “Brand exclusions” from 1 campaign', review: { kind: 'remove' } });
    expect(mutates(f)[0]!.body).toEqual({ operations: [{ remove: `${ROOT}/campaignSharedSets/11~501` }], validateOnly: true, partialFailure: false });
    await expect(f.provider.previewWrite(op('google_link_negative_keyword_list', { shared_set_id: '501', action: 'attach', campaign_ids: ['11'] }, 'update'), guard)).rejects.toThrow('already attached');
    await expect(f.provider.previewWrite(op('google_link_negative_keyword_list', { shared_set_id: '501', action: 'attach', campaign_ids: ['13'] }, 'create'), guard)).rejects.toThrow('kind mismatch');
    await expect(f.provider.previewWrite(op('google_link_negative_keyword_list', { shared_set_id: '501', action: 'attach', campaign_ids: ['11', '11'] }, 'update'), guard)).rejects.toThrow('duplicates');
  });

  it('adds campaign-level negatives to many campaigns, skipping what each campaign already excludes', async () => {
    const f = fixture(), operation = op('google_add_campaign_negative_keywords', { campaign_ids: ['11', '12'], keywords: [kw('cheap', 'EXACT'), kw('diy', 'PHRASE'), kw('DIY', 'PHRASE')] }, 'create');
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview).toMatchObject({ summary: 'Add 3 campaign negative keywords to 2 Google campaigns', review: { fields: [{ label: 'Negative keywords to add', after: '3 across 2 campaigns' }, { label: 'Search FR (11): +2', after: ['[cheap]', '"diy"'] }, { label: 'Search BE (12): +1, 1 already present', after: ['"diy"'] }, { label: 'Skipped duplicates (1)', after: ['"DIY"'] }] } });
    expect(f.calls.find(call => call.body.query?.includes('FROM campaign_criterion'))!.body.query).toContain("campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED'");
    const create = (campaignId: string, text: string, matchType: string) => ({ create: { campaign: `${ROOT}/campaigns/${campaignId}`, negative: true, keyword: { text, matchType } } });
    expect(mutates(f).map(call => [call.url, call.body])).toEqual([[`${base}/campaignCriteria:mutate`, { operations: [create('11', 'cheap', 'EXACT'), create('11', 'diy', 'PHRASE'), create('12', 'diy', 'PHRASE')], validateOnly: true, partialFailure: false }]]);
    expect(await f.provider.applyWrite(operation, guard)).toMatchObject({ resourceIds: [`${ROOT}/campaignCriteria/11~100000`, `${ROOT}/campaignCriteria/11~100001`, `${ROOT}/campaignCriteria/12~100002`], details: { added: 3, skipped_duplicates: 1 } });
    await expect(f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ['12'], keywords: [kw('CHEAP', 'EXACT')] }, 'create'), guard)).rejects.toThrow('already a negative keyword');
  });

  it('reads campaign negative inventories in parallel, at most 10 at a time, keeping campaign order', async () => {
    const f = fixture(), ids = Array.from({ length: 25 }, (_, i) => String(20 + i));
    f.state.campaigns.push(...ids.map(id => campaign(id, `Search ${id}`)));
    f.state.campaignNegatives.push({ campaign: '44', id: '7002', text: 'cheap', matchType: 'EXACT' });
    const preview = await f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ids, keywords: [kw('cheap', 'EXACT')] }, 'create'), guard);
    expect(f.state.inventoryReads.peak).toBe(10);
    expect(preview.summary).toBe('Add 24 campaign negative keywords to 24 Google campaigns');
    expect(preview.changes.slice(0, 25).map(line => line.match(/\((\d+)\)/)![1])).toEqual(ids);
    expect(preview.changes[24]).toContain('no change (skipped 1 already present)');
  });

  it('rejects campaign negatives over the 10,000 per-campaign limit and the 20,000 operation bound before any mutate', async () => {
    const f = fixture();
    f.state.campaignNegatives = Array.from({ length: 9999 }, (_, i) => ({ campaign: '11', id: String(30000 + i), text: `n${i}`, matchType: 'BROAD' }));
    await expect(f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ['11'], keywords: [kw('a'), kw('b')] }, 'create'), guard)).rejects.toThrow('campaign 11 would exceed 10000 negative keywords');
    expect(await f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ['11'], keywords: [kw('a')] }, 'create'), guard)).toMatchObject({ summary: 'Add 1 campaign negative keyword to 1 Google campaign' });
    f.calls.length = 0;
    f.state.campaignNegatives = [];
    f.state.campaigns.push(campaign('14', 'Search LU'), campaign('15', 'Search NL'));
    const keywords = Array.from({ length: 5000 }, (_, i) => kw(`k${i}`));
    await expect(f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ['11', '12', '13', '14', '15'], keywords }, 'create'), guard)).rejects.toThrow('25000 operations exceed the 20000 per-call bound');
    expect(mutates(f)).toEqual([]);
  });

  it('validates and applies the maximum campaign operation count in two atomic batches per phase', async () => {
    const f = fixture();
    f.state.campaigns.push(campaign('14', 'Search LU'));
    const keywords = Array.from({ length: 5000 }, (_, i) => kw('exclude ' + i));
    const change = op('google_add_campaign_negative_keywords', { campaign_ids: ['11', '12', '13', '14'], keywords }, 'create');
    await f.provider.previewWrite(change, guard);
    await f.provider.applyWrite(change, guard);
    expect(mutates(f).map(({ body }) => [body.validateOnly, body.operations.length])).toEqual([
      [true, 10000], [true, 10000], [false, 10000], [false, 10000],
    ]);
  });

  it('surfaces Google error envelopes and reports partial batch progress without retrying', async () => {
    const f = fixture();
    f.state.fail = url => url.endsWith('/campaignCriteria:mutate');
    await expect(f.provider.previewWrite(op('google_add_campaign_negative_keywords', { campaign_ids: ['11'], keywords: [kw('bad!')] }, 'create'), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('at operations[0].create: Keyword text has invalid characters. [request-id: req-1]') });
    f.calls.length = 0;
    let writes = 0;
    f.state.fail = (url, body) => url.endsWith('/sharedCriteria:mutate') && !body.validateOnly && ++writes === 2;
    const keywords = Array.from({ length: 1500 }, (_, i) => kw(`k${i}`));
    const error = await f.provider.applyWrite(op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: keywords }, 'update'), guard).catch(value => value);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('stopped after 1000 of 1500 confirmed operations') });
    expect(error.details.resourceIds).toHaveLength(1000);
    expect(mutates(f).filter(call => !call.body.validateOnly)).toHaveLength(2);
    f.state.fail = undefined;
    // Re-running the same request skips the 1,000 keywords already applied.
    expect((await f.provider.applyWrite(op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: keywords }, 'update'), guard)).details).toMatchObject({ added: 500, skipped_already_present: 1000 });
  });

  it.each(['network', 'server'])('reports an unconfirmed first batch after a %s failure without retrying', async failure => {
    const f = fixture();
    f.state.response = (url, body) => {
      if (!url.endsWith(':mutate') || body.validateOnly) return undefined;
      if (failure === 'network') throw new TypeError('connection lost');
      return Response.json({ error: { code: 503, status: 'UNAVAILABLE' } }, { status: 503 });
    };
    const create = op('google_create_negative_keyword_list', { name: 'QA list', keywords: [kw('one')] }, 'create');
    const update = op('google_update_negative_keyword_list', { shared_set_id: '501', add_keywords: [kw('one')] }, 'update');
    for (const [index, write] of [create, update].entries()) {
      await expect(f.provider.applyWrite(write, guard)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR', message: expect.stringContaining('may have been applied'),
        details: { resourceIds: [], unconfirmed_operations: index === 0 ? 2 : 1 },
      });
    }
    expect(mutates(f)).toHaveLength(2);
  });

  it('keeps writes behind the two-step policy gate', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>();
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); }, async consume(id: string, expectedHash: string) { const value = pending.get(id); return !!value && value.opHash === expectedHash && Date.parse(value.expiresAt) > Date.now() && pending.delete(id); } }, { async append() {} });
    const runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const args = { account_id: A, shared_set_id: '501', action: 'attach', campaign_ids: ['13'] };
    const preview = await runtime.registry.call('google_link_negative_keyword_list', args, runtime.ctx) as { applied: boolean; pending_operation_id: string };
    expect(preview.applied).toBe(false); expect(mutates(f).every(call => call.body.validateOnly === true)).toBe(true);
    await expect(runtime.registry.call('google_link_negative_keyword_list', { ...args, campaign_ids: ['12'], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(await runtime.registry.call('google_link_negative_keyword_list', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ applied: true });
    expect(mutates(f).filter(call => !call.body.validateOnly)).toHaveLength(1);
  });
});

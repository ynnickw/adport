import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Official Google Ads v25 protos, googleapis/googleapis@97f6460c (2026-11-12):
// resources/custom_conversion_goal, conversion_goal_campaign_config,
// campaign_conversion_goal; services/custom_conversion_goal_service,
// conversion_goal_campaign_config_service, campaign_conversion_goal_service and
// google_ads_service (MutateOperation fields 67/68/69) and
// errors/custom_conversion_goal_error (CANNOT_REMOVE_LINKED_CUSTOM_CONVERSION_GOAL,
// CUSTOM_GOAL_DUPLICATE_NAME). Behaviour from
// developers.google.com/google-ads/api/docs/conversions/goals/{overview,campaign-goals},
// checked 2026-11-25: custom goals live in the conversion customer and are listed
// from client accounts; the guide says the backend moves the campaign to CAMPAIGN
// on a custom goal or CampaignConversionGoal change, but Adport sets
// goal_config_level explicitly, so this mock never switches the level on its own;
// CUSTOMER reverts. The per-service mutate requests have no partial_failure
// field, so writes use atomic googleAds:mutate.
// Fixtures are synthetic; no live API calls or real account IDs.
type Row = Record<string, any>;
const A = '1234567890', ROOT = `customers/${A}`, guard = { forcePausedCreation: true };
const actionResource = (id: string) => `${ROOT}/conversionActions/${id}`;
const goalResource = (id: string) => `${ROOT}/customConversionGoals/${id}`;
const campaignResource = (id: string) => `${ROOT}/campaigns/${id}`;
const standard = (campaignId: string, category: string, origin: string, biddable: boolean) => ({ resourceName: `${ROOT}/campaignConversionGoals/${campaignId}~${category}~${origin}`, campaign: campaignResource(campaignId), category, origin, biddable });
const ids = (query: string, field: string) => query.match(new RegExp(`${field.replace('.', '\\.')} IN \\(([^)]+)\\)`))?.[1]!.split(',') ?? query.match(new RegExp(`${field.replace('.', '\\.')} = (\\d+)`))?.slice(1) ?? null;

function fixture(options: { conversionCustomer?: string; handler?(url: URL, body: Row): unknown } = {}) {
  const state: Row = {
    customer: { resourceName: ROOT, id: A, currencyCode: 'EUR', conversionTrackingSetting: { googleAdsConversionCustomer: options.conversionCustomer ?? ROOT, conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF' } },
    actions: [
      { resourceName: actionResource('501'), id: '501', name: 'Demo request', status: 'ENABLED', category: 'SUBMIT_LEAD_FORM', type: 'WEBPAGE' },
      { resourceName: actionResource('502'), id: '502', name: 'Trial signup', status: 'ENABLED', category: 'SIGNUP', type: 'WEBPAGE' },
      { resourceName: actionResource('503'), id: '503', name: 'Old form', status: 'REMOVED', category: 'SUBMIT_LEAD_FORM', type: 'WEBPAGE' },
    ],
    goals: [{ resourceName: goalResource('701'), id: '701', name: 'Leads only', status: 'ENABLED', conversionActions: [actionResource('501')] }],
    campaigns: ['11', '12', '13'].map((id, index) => ({ resourceName: campaignResource(id), id, name: `Search ${index + 1}`, status: index === 2 ? 'PAUSED' : 'ENABLED', advertisingChannelType: 'SEARCH' })),
    configs: ['11', '12', '13'].map(id => ({ resourceName: `${ROOT}/conversionGoalCampaignConfigs/${id}`, campaign: campaignResource(id), goalConfigLevel: 'CUSTOMER' })),
    standard: ['11', '12', '13'].flatMap(id => [standard(id, 'PURCHASE', 'WEBSITE', true), standard(id, 'SUBMIT_LEAD_FORM', 'WEBSITE', true)]),
  };
  const calls: Array<{ url: URL; body: Row; init: RequestInit }> = []; let nextGoal = 702;
  const client = new GoogleAdsRestClient({ clientId: 'inert', clientSecret: 'inert', refreshToken: 'inert', loginCustomerId: '9876543210' }, 'v25', async (raw, init = {}) => {
    const url = new URL(String(raw)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}')); calls.push({ url, body, init });
    const custom = options.handler?.(url, body); if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
    if (url.pathname.endsWith('googleAds:search')) {
      const query = String(body.query), from = query.match(/ FROM (\w+)/)![1];
      if (from === 'customer') return Response.json({ results: [{ customer: state.customer }] });
      if (from === 'custom_conversion_goal') {
        const wanted = ids(query, 'custom_conversion_goal.id'), after = query.match(/custom_conversion_goal\.id > (\d+)/)?.[1];
        return Response.json({ results: state.goals.filter((goal: Row) => (!wanted || wanted.includes(goal.id)) && (!after || BigInt(goal.id) > BigInt(after)) && (!query.includes("status != 'REMOVED'") || goal.status !== 'REMOVED')).map((goal: Row) => ({ customConversionGoal: goal })) });
      }
      if (from === 'conversion_action') { const wanted = ids(query, 'conversion_action.id')!; return Response.json({ results: state.actions.filter((action: Row) => wanted.includes(action.id)).map((action: Row) => ({ conversionAction: action })) }); }
      if (from === 'campaign') { const wanted = ids(query, 'campaign.id')!; return Response.json({ results: state.campaigns.filter((row: Row) => wanted.includes(row.id)).map((row: Row) => ({ campaign: row })) }); }
      if (from === 'conversion_goal_campaign_config') {
        const wanted = ids(query, 'campaign.id')!; return Response.json({ results: state.configs.filter((row: Row) => wanted.includes(row.campaign.split('/').at(-1))).map((row: Row) => ({ conversionGoalCampaignConfig: row, campaign: { id: row.campaign.split('/').at(-1) } })) });
      }
      if (from === 'campaign_conversion_goal') { const wanted = ids(query, 'campaign.id')!; return Response.json({ results: state.standard.filter((row: Row) => wanted.includes(row.campaign.split('/').at(-1))).map((row: Row) => ({ campaignConversionGoal: row, campaign: { id: row.campaign.split('/').at(-1) } })) }); }
      throw new Error(`Unexpected native query ${query}`);
    }
    if (!url.pathname.endsWith('googleAds:mutate')) throw new Error('Unexpected native endpoint');
    if (body.validateOnly) return Response.json({});
    const responses = body.mutateOperations.map((operation: Row) => {
      if (operation.customConversionGoalOperation) {
        const value = operation.customConversionGoalOperation;
        if (value.create) { const id = String(nextGoal++); state.goals.push({ resourceName: goalResource(id), id, status: 'ENABLED', ...value.create }); return { customConversionGoalResult: { resourceName: goalResource(id) } }; }
        throw new Error('Unexpected custom goal operation');
      }
      if (operation.conversionGoalCampaignConfigOperation) {
        const value = operation.conversionGoalCampaignConfigOperation, config = state.configs.find((row: Row) => row.resourceName === value.update.resourceName);
        const mask = String(value.updateMask).split(',');
        if (mask.includes('goal_config_level')) { config.goalConfigLevel = value.update.goalConfigLevel; if (value.update.goalConfigLevel === 'CUSTOMER') for (const row of state.standard) if (row.campaign === config.campaign) row.biddable = true; }
        if (mask.includes('custom_conversion_goal')) config.customConversionGoal = value.update.customConversionGoal;
        return { conversionGoalCampaignConfigResult: { resourceName: config.resourceName } };
      }
      const value = operation.campaignConversionGoalOperation, row = state.standard.find((item: Row) => item.resourceName === value.update.resourceName);
      row.biddable = value.update.biddable;
      return { campaignConversionGoalResult: { resourceName: row.resourceName } };
    });
    return Response.json({ mutateOperationResponses: responses });
  });
  return { state, calls, provider: new GoogleAdsProvider(client) };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(call => call.url.pathname.endsWith('googleAds:mutate'));
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'google', accountId: A, kind, tool, payload });
async function goalHash(f: ReturnType<typeof fixture>, id = '701') { return (await f.provider.conversionGoals.list({ account_id: A, limit: 50, include_removed: true })).goals.find(goal => goal.custom_conversion_goal_id === id)!.snapshot_hash; }
async function setOp(f: ReturnType<typeof fixture>, campaigns: string[], fields: Row) { const read = await f.provider.conversionGoals.list({ account_id: A, limit: 50, campaign_ids: campaigns }); return op('google_set_campaign_conversion_goal', { campaign_ids: campaigns, expected_snapshot_hash: read.snapshot_hash, ...fields }); }
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('conversion goal tool surface', () => {
  it('registers lean named tools and rejects ambiguous inputs', () => {
    const tools = googleTools(new Proxy({} as GoogleAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(tool => /conversion_goal/.test(tool.name)).map(tool => tool.name)).toEqual(['google_custom_conversion_goals', 'google_create_custom_conversion_goal', 'google_set_campaign_conversion_goal']);
    const set = tools.find(tool => tool.name === 'google_set_campaign_conversion_goal')!.input, base = { account_id: A, campaign_ids: ['11'], expected_snapshot_hash: 'a'.repeat(64) };
    expect(set.safeParse({ ...base, goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: 'b'.repeat(64) }, standard_goals: 'DISABLE_ALL' }).success).toBe(true);
    for (const input of [{}, { goal: { type: 'ACCOUNT_DEFAULT' }, standard_goals: 'DISABLE_ALL' }, { campaign_ids: ['11', '11'], goal: { type: 'ACCOUNT_DEFAULT' } }, { campaign_ids: Array.from({ length: 51 }, (_, i) => String(i + 1)), goal: { type: 'ACCOUNT_DEFAULT' } }, { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701' } }, { standard_goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }, { category: 'PURCHASE', origin: 'WEBSITE', biddable: true }] }, { standard_goals: [{ category: 'PURCHASE', origin: 'NOWHERE', biddable: false }] }, { standard_goals: [{ category: "PURCHASE' OR 1=1", origin: 'WEBSITE', biddable: false }] }])
      expect(set.safeParse({ ...base, ...input }).success, JSON.stringify(input)).toBe(false);
    const create = tools.find(tool => tool.name === 'google_create_custom_conversion_goal')!.input;
    for (const input of [{ name: ' ', conversion_action_ids: ['501'] }, { name: 'Goal', conversion_action_ids: [] }, { name: 'Goal', conversion_action_ids: ['501', '501'] }]) expect(create.safeParse({ account_id: A, ...input }).success).toBe(false);
    const read = tools.find(tool => tool.name === 'google_custom_conversion_goals')!.input;
    expect(read.safeParse({ account_id: A, campaign_ids: ['11', '11'] }).success).toBe(false);
  });
});

describe('conversion goal reads', () => {
  it('lists custom goals with resolved action names, ordered continuation and a stable hash', async () => {
    const f = fixture(); f.state.goals.push({ resourceName: goalResource('702'), id: '702', name: 'Signups', status: 'ENABLED', conversionActions: [actionResource('502'), `customers/5555555555/conversionActions/999`] });
    const first = await f.provider.conversionGoals.list({ account_id: A, limit: 1 });
    expect(first).toMatchObject({ conversion_customer: ROOT, truncated: true, next_cursor: '701', goals: [{ custom_conversion_goal_id: '701', name: 'Leads only', status: 'ENABLED', conversion_actions: [{ conversion_action_id: '501', name: 'Demo request', category: 'SUBMIT_LEAD_FORM' }], snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    const query = f.calls.find(call => call.body.query?.includes('FROM custom_conversion_goal'))!.body.query;
    expect(query).toBe("SELECT custom_conversion_goal.resource_name, custom_conversion_goal.id, custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.status != 'REMOVED' ORDER BY custom_conversion_goal.id ASC LIMIT 2");
    const second = await f.provider.conversionGoals.list({ account_id: A, limit: 1, after_goal_id: '701' });
    expect(second.goals[0]!.conversion_actions[1]).toEqual({ conversion_action_id: '999', resource_name: 'customers/5555555555/conversionActions/999', name: null });
    expect(f.calls.at(-1)!.body.query).toContain('conversion_action.id IN (502,999)');
    expect(second).not.toHaveProperty('campaigns');
    expect(f.calls.some(call => call.body.query?.includes('FROM campaign'))).toBe(false);
    expect(mutations(f)).toEqual([]);
  });

  it('keeps the goal hash stable when Google reorders its actions', async () => {
    const f = fixture(); f.state.goals[0].conversionActions = [actionResource('502'), actionResource('501')];
    const hash = await goalHash(f);
    f.state.goals[0].conversionActions.reverse();
    expect(await goalHash(f)).toBe(hash);
    const write = await setOp(f, ['11'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: hash } });
    f.state.goals[0].conversionActions.reverse();
    await expect(f.provider.previewWrite(write, guard)).resolves.toMatchObject({ serverValidated: true });
  });

  it('lists conversion-customer goals the client returns, and shows an unreturned one by resource name only', async () => {
    const OWNER = 'customers/5555555555', owned = `${OWNER}/customConversionGoals/801`, hidden = `${OWNER}/customConversionGoals/802`;
    const f = fixture({ conversionCustomer: OWNER }); f.state.goals.push({ resourceName: owned, id: '801', name: 'Manager leads', status: 'ENABLED', conversionActions: [`${OWNER}/conversionActions/901`] });
    Object.assign(f.state.configs[0], { goalConfigLevel: 'CAMPAIGN', customConversionGoal: hidden });
    const read = await f.provider.conversionGoals.list({ account_id: A, limit: 50, campaign_ids: ['11'] });
    expect(read.goals.map(goal => goal.resource_name)).toEqual([goalResource('701'), owned]);
    expect(read.campaigns![0]).toMatchObject({ custom_conversion_goal: { resource_name: hidden }, summary: expect.stringContaining('custom goal 802') });
    const write = op('google_set_campaign_conversion_goal', { campaign_ids: ['11'], expected_snapshot_hash: read.snapshot_hash, goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '802', expected_goal_hash: 'a'.repeat(64) } });
    await expect(f.provider.previewWrite(write, guard)).rejects.toThrow(/not returned by the selected account/);
    expect(mutations(f)).toEqual([]);
  });

  it('rejects goals outside the account and its conversion customer', async () => {
    const f = fixture(); f.state.goals[0].resourceName = 'customers/9999999999/customConversionGoals/701';
    await expect(f.provider.conversionGoals.list({ account_id: A, limit: 10 })).rejects.toThrow(/invalid identity/);
  });

  it('describes each campaign goal setup in plain words with an order-independent snapshot', async () => {
    const f = fixture(); Object.assign(f.state.configs[1], { goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') }); f.state.standard[2].biddable = false;
    const read = await f.provider.conversionGoals.list({ account_id: A, limit: 50, campaign_ids: ['12', '11'] });
    expect(read.goals).toHaveLength(1);
    expect(read.campaigns).toEqual([
      expect.objectContaining({ campaign_id: '12', name: 'Search 2', goal_config_level: 'CAMPAIGN', custom_conversion_goal: expect.objectContaining({ name: 'Leads only' }), standard_goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }, { category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true }], summary: 'Campaign-specific goals: custom goal "Leads only" optimizing for "Demo request"; standard goals used for bidding: Submit lead form · Website' }),
      expect.objectContaining({ campaign_id: '11', goal_config_level: 'CUSTOMER', custom_conversion_goal: null, summary: 'Account default goals (Purchase · Website, Submit lead form · Website)' }),
    ]);
    expect(read.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(read.snapshot_hash).toBe((await f.provider.conversionGoals.list({ account_id: A, limit: 50, campaign_ids: ['11', '12'] })).snapshot_hash);
    const queries = f.calls.map(call => call.body.query).filter(Boolean);
    expect(queries).toContain('SELECT conversion_goal_campaign_config.resource_name, conversion_goal_campaign_config.campaign, conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal, campaign.id FROM conversion_goal_campaign_config WHERE campaign.id IN (12,11) LIMIT 3');
    expect(queries).toContain('SELECT campaign_conversion_goal.resource_name, campaign_conversion_goal.campaign, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable, campaign.id FROM campaign_conversion_goal WHERE campaign.id IN (12,11) LIMIT 401');
  });

  it.each(['missing', 'removed', 'foreign-config', 'missing-config', 'bad-standard'] as const)('refuses unverifiable campaign goal state: %s', async mode => {
    const f = fixture();
    if (mode === 'missing') f.state.campaigns.pop();
    if (mode === 'removed') f.state.campaigns[2].status = 'REMOVED';
    if (mode === 'foreign-config') f.state.configs[0].customConversionGoal = 'customers/9999999999/customConversionGoals/1';
    if (mode === 'missing-config') f.state.configs.pop();
    if (mode === 'bad-standard') f.state.standard[0].resourceName = `${ROOT}/campaignConversionGoals/99~PURCHASE~WEBSITE`;
    await expect(f.provider.conversionGoals.list({ account_id: A, limit: 50, campaign_ids: ['11', '12', '13'] })).rejects.toThrow();
  });
});

describe('custom conversion goal writes', () => {
  it('creates a goal from enabled actions with native validate_only and an exact receipt', async () => {
    const f = fixture(), write = op('google_create_custom_conversion_goal', { name: 'Leads and trials', conversion_action_ids: ['501', '502'] }, 'create');
    const preview = await f.provider.previewWrite(write, guard);
    expect(preview).toMatchObject({ serverValidated: true, summary: 'Create Google custom conversion goal "Leads and trials"', review: { title: 'Create custom conversion goal', fields: [{ label: 'Goal name', after: 'Leads and trials' }, { label: 'Optimizes for', after: ['Demo request [501]', 'Trial signup [502]'] }] } });
    const [validate] = mutations(f);
    expect(validate!.url.pathname).toBe(`/v25/customers/${A}/googleAds:mutate`);
    expect(validate!.init.method).toBe('POST');
    expect(validate!.body).toEqual({ mutateOperations: [{ customConversionGoalOperation: { create: { name: 'Leads and trials', conversionActions: [actionResource('501'), actionResource('502')] } } }], validateOnly: true, partialFailure: false });
    expect(await f.provider.applyWrite(write, guard)).toEqual({ applied: true, resourceIds: [goalResource('702')] });
    expect(mutations(f).map(call => call.body.validateOnly)).toEqual([true, false]);
  });

  it.each([
    ['removed action', { conversion_action_ids: ['503'] }, {}, /REMOVED/],
    ['unknown action', { conversion_action_ids: ['501', '404'] }, {}, /not found.*404/],
    ['manager-owned tracking', { conversion_action_ids: ['501'] }, { conversionCustomer: 'customers/5555555555' }, /conversion customer customers\/5555555555/],
  ] as const)('rejects creation before any mutate: %s', async (_name, payload, options, message) => {
    const f = fixture(options);
    await expect(f.provider.previewWrite(op('google_create_custom_conversion_goal', { name: 'Goal', ...payload }, 'create'), guard)).rejects.toThrow(message);
    expect(mutations(f)).toEqual([]);
  });

  it('surfaces the native error envelope from validate_only without applying', async () => {
    const f = fixture({ handler: url => url.pathname.endsWith('googleAds:mutate') ? new Response(JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', requestId: 'req-1', errors: [{ errorCode: { customConversionGoalError: 'CUSTOM_GOAL_DUPLICATE_NAME' }, message: 'Custom goal name is already used.', location: { fieldPathElements: [{ fieldName: 'mutate_operations', index: 0 }, { fieldName: 'custom_conversion_goal_operation' }] } }] }] } }), { status: 400 }) : undefined });
    await expect(f.provider.previewWrite(op('google_create_custom_conversion_goal', { name: 'Leads only', conversion_action_ids: ['501'] }, 'create'), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/HTTP 400.*\n  at mutate_operations\[0\]\.custom_conversion_goal_operation: Custom goal name is already used\. \[request-id: req-1\]/s) });
    expect(mutations(f)).toHaveLength(1);
  });

  it('rejects a mismatched create receipt', async () => {
    const f = fixture({ handler: (url, body) => url.pathname.endsWith('googleAds:mutate') && !body.validateOnly ? { mutateOperationResponses: [{ customConversionGoalResult: { resourceName: 'customers/9999999999/customConversionGoals/1' } }] } : undefined });
    await expect(f.provider.applyWrite(op('google_create_custom_conversion_goal', { name: 'Goal', conversion_action_ids: ['501'] }, 'create'), guard)).rejects.toThrow(/receipt mismatch/);
  });
});

describe('campaign conversion goal writes', () => {
  it('moves several campaigns to a custom goal in one atomic plan, with plain before/after per campaign', async () => {
    const f = fixture(), write = await setOp(f, ['11', '12', '13'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: await goalHash(f) }, standard_goals: 'DISABLE_ALL' });
    const preview = await f.provider.previewWrite(write, guard);
    expect(preview.summary).toBe('Use custom conversion goal "Leads only" on 3 Google campaigns');
    expect(preview.fieldChanges![0]).toEqual({ field: 'Search 1 [11]', before: 'Account default goals (Purchase · Website, Submit lead form · Website)', after: 'Campaign-specific goals: custom goal "Leads only" optimizing for "Demo request"; no standard goals used for bidding' });
    expect(preview.review).toMatchObject({ title: 'Set campaign conversion goals', subject: 'Leads only' });
    expect(preview.notes!.some(note => /also keeps bidding/.test(note))).toBe(false);
    const body = mutations(f)[0]!.body;
    expect(body).toMatchObject({ validateOnly: true, partialFailure: false });
    expect(body.mutateOperations.slice(0, 3)).toEqual(['11', '12', '13'].map(id => ({ conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/${id}`, goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') }, updateMask: 'goal_config_level,custom_conversion_goal' } })));
    expect(body.mutateOperations.slice(3)).toEqual(['11', '12', '13'].flatMap(id => ['PURCHASE', 'SUBMIT_LEAD_FORM'].map(category => ({ campaignConversionGoalOperation: { update: { resourceName: `${ROOT}/campaignConversionGoals/${id}~${category}~WEBSITE`, biddable: false }, updateMask: 'biddable' } }))));
    const result = await f.provider.applyWrite(write, guard);
    expect(result).toMatchObject({ applied: true, details: { campaigns_changed: 3, operations: 9, readback_verified: true } });
    expect(result.resourceIds).toHaveLength(9);
    expect(mutations(f).map(call => call.body.validateOnly)).toEqual([true, false]);
    expect(f.state.configs.every((row: Row) => row.goalConfigLevel === 'CAMPAIGN' && row.customConversionGoal === goalResource('701'))).toBe(true);
    expect(f.state.campaigns.map((row: Row) => row.status)).toEqual(['ENABLED', 'ENABLED', 'PAUSED']);
  });

  it('warns when a custom goal still shares bidding with standard goals, and skips campaigns already set', async () => {
    const f = fixture(); Object.assign(f.state.configs[0], { goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') });
    const preview = await f.provider.previewWrite(await setOp(f, ['11', '12'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: await goalHash(f) } }), guard);
    expect(preview.summary).toBe('Use custom conversion goal "Leads only" on 1 Google campaign');
    expect(preview.fieldChanges![0]!.after).toBe('No change');
    expect(preview.notes![0]).toMatch(/^Search 1 \[11\] also keeps bidding on Purchase · Website, Submit lead form · Website\. Pass standard_goals="DISABLE_ALL"/);
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/12`, goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') }, updateMask: 'goal_config_level,custom_conversion_goal' } }]);
  });

  it('switches an already campaign-level campaign to another custom goal with the goal mask only', async () => {
    const f = fixture(); f.state.goals.push({ resourceName: goalResource('702'), id: '702', name: 'Trials', status: 'ENABLED', conversionActions: [actionResource('502')] }); Object.assign(f.state.configs[0], { goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') });
    const write = await setOp(f, ['11'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '702', expected_goal_hash: await goalHash(f, '702') } });
    await f.provider.applyWrite(write, guard);
    expect(mutations(f).at(-1)!.body.mutateOperations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/11`, customConversionGoal: goalResource('702') }, updateMask: 'custom_conversion_goal' } }]);
    expect(f.state.configs[0]).toMatchObject({ goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('702') });
  });

  it('restores account defaults only where campaign-level goals are set', async () => {
    const f = fixture(); Object.assign(f.state.configs[1], { goalConfigLevel: 'CAMPAIGN', customConversionGoal: goalResource('701') }); f.state.standard[2].biddable = false;
    const write = await setOp(f, ['11', '12'], { goal: { type: 'ACCOUNT_DEFAULT' } });
    const preview = await f.provider.previewWrite(write, guard);
    expect(preview.summary).toBe('Restore account default conversion goals on 1 Google campaign');
    expect(preview.fieldChanges![0]!.after).toBe('No change');
    expect(preview.fieldChanges![1]).toEqual({ field: 'Search 2 [12]', before: 'Campaign-specific goals: custom goal "Leads only" optimizing for "Demo request"; standard goals used for bidding: Submit lead form · Website', after: 'Account default goals (campaign-specific and custom goals no longer apply)' });
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([{ conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/12`, goalConfigLevel: 'CUSTOMER' }, updateMask: 'goal_config_level' } }]);
    await f.provider.applyWrite(write, guard);
    expect(f.state.configs[1].goalConfigLevel).toBe('CUSTOMER');
  });

  it('rejects removing the last bidding goal for any campaign in the batch before mutation', async () => {
    const f = fixture();
    f.state.standard[3].biddable = false;
    for (const standard_goals of ['DISABLE_ALL', [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }]]) {
      const write = await setOp(f, ['11', '12'], { standard_goals });
      await expect(f.provider.previewWrite(write, guard)).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('at least one biddable standard goal or a custom conversion goal') });
    }
    expect(mutations(f)).toEqual([]);
  });

  it('toggles selected standard goals, switching the level first in the same request', async () => {
    const f = fixture(); f.state.configs[1].goalConfigLevel = 'CAMPAIGN';
    const write = await setOp(f, ['11', '12'], { standard_goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] });
    const preview = await f.provider.previewWrite(write, guard);
    expect(preview.fieldChanges![0]).toEqual({ field: 'Search 1 [11]', before: 'Account default goals (Purchase · Website, Submit lead form · Website)', after: 'Campaign-specific goals: standard goals used for bidding: Submit lead form · Website' });
    expect(mutations(f)[0]!.body.mutateOperations).toEqual([
      { conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/11`, goalConfigLevel: 'CAMPAIGN' }, updateMask: 'goal_config_level' } },
      ...['11', '12'].map(id => ({ campaignConversionGoalOperation: { update: { resourceName: `${ROOT}/campaignConversionGoals/${id}~PURCHASE~WEBSITE`, biddable: false }, updateMask: 'biddable' } })),
    ]);
    expect(await f.provider.applyWrite(write, guard)).toMatchObject({ applied: true, details: { readback_verified: true } });
    expect(f.state.configs.slice(0, 2).map((row: Row) => row.goalConfigLevel)).toEqual(['CAMPAIGN', 'CAMPAIGN']);
  });

  it('clears a custom goal retained at account level when only standard goals are toggled', async () => {
    const f = fixture(); Object.assign(f.state.configs[0], { goalConfigLevel: 'CUSTOMER', customConversionGoal: goalResource('701') });
    const write = await setOp(f, ['11'], { standard_goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] });
    const preview = await f.provider.previewWrite(write, guard);
    expect(preview.fieldChanges![0]!.after).toBe('Campaign-specific goals: standard goals used for bidding: Submit lead form · Website');
    expect(mutations(f)[0]!.body.mutateOperations[0]).toEqual({ conversionGoalCampaignConfigOperation: { update: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/11`, goalConfigLevel: 'CAMPAIGN' }, updateMask: 'goal_config_level,custom_conversion_goal' } });
    expect(await f.provider.applyWrite(write, guard)).toMatchObject({ applied: true, details: { readback_verified: true } });
    expect(f.state.configs[0]).toMatchObject({ goalConfigLevel: 'CAMPAIGN', customConversionGoal: undefined });
  });

  it('does not certify a standard-goal apply when a custom goal is still set after readback', async () => {
    let applied = false;
    const f = fixture({ handler: (url, body) => {
      if (url.pathname.endsWith('googleAds:mutate') && !body.validateOnly) applied = true;
      if (applied && body.query?.includes('FROM conversion_goal_campaign_config')) f.state.configs[0].customConversionGoal = goalResource('701');
      return undefined;
    } });
    const write = await setOp(f, ['11'], { standard_goals: [{ category: 'PURCHASE', origin: 'WEBSITE', biddable: false }] });
    await expect(f.provider.applyWrite(write, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('not confirmed') });
  });

  it.each(['stale', 'no-change', 'missing-pair', 'removed-goal', 'stale-goal'] as const)('rejects before any mutate: %s', async mode => {
    const f = fixture(), hash = await goalHash(f);
    if (mode === 'removed-goal') f.state.goals[0].status = 'REMOVED';
    const fields = mode === 'no-change' ? { goal: { type: 'ACCOUNT_DEFAULT' } } : mode === 'missing-pair' ? { standard_goals: [{ category: 'STORE_VISIT', origin: 'STORE', biddable: true }] } : { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: mode === 'removed-goal' ? await goalHash(f) : hash } };
    const write = await setOp(f, ['11', '12'], fields);
    if (mode === 'stale') f.state.standard[0].biddable = false;
    if (mode === 'stale-goal') f.state.goals[0].conversionActions.push(actionResource('502'));
    await expect(f.provider.previewWrite(write, guard)).rejects.toThrow({ stale: /changed/, 'no-change': /already has/, 'missing-pair': /has no STORE_VISIT\/STORE goal/, 'removed-goal': /removed/, 'stale-goal': /changed/ }[mode]);
    expect(mutations(f)).toEqual([]);
  });

  it.each(['receipt', 'partial', 'readback', 'transport', 'server'] as const)('never certifies or retries an unconfirmed apply: %s', async mode => {
    let applied = false;
    const f = fixture({ handler: (url, body) => {
      if (url.pathname.endsWith('googleAds:mutate') && !body.validateOnly) {
        applied = true;
        if (mode === 'transport') throw new Error('socket closed');
        if (mode === 'server') return new Response(JSON.stringify({ error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } }), { status: 503 });
        if (mode === 'receipt') return { mutateOperationResponses: [{ campaignConversionGoalResult: { resourceName: `${ROOT}/conversionGoalCampaignConfigs/11` } }] };
        if (mode === 'partial') return { partialFailureError: { code: 3 }, mutateOperationResponses: [] };
      }
      if (mode === 'readback' && applied && body.query?.includes('FROM conversion_goal_campaign_config')) f.state.configs[0].goalConfigLevel = 'CUSTOMER';
      return undefined;
    } });
    const write = await setOp(f, ['11'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: await goalHash(f) } });
    await expect(f.provider.applyWrite(write, guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringContaining('not confirmed') });
    expect(mutations(f)).toHaveLength(1);
  });

  it('rethrows a clean native rejection of the apply mutate instead of reporting an unconfirmed outcome', async () => {
    const f = fixture({ handler: (url, body) => url.pathname.endsWith('googleAds:mutate') && !body.validateOnly ? new Response(JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure', requestId: 'req-2', errors: [{ errorCode: { conversionGoalCampaignConfigError: 'CANNOT_USE_CAMPAIGN_GOAL_FOR_SEARCH_ADS_360_MANAGED_CAMPAIGN' }, message: 'Campaign goals are not supported.' }] }] } }), { status: 400 }) : undefined });
    const write = await setOp(f, ['11'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: await goalHash(f) } });
    const error = await f.provider.applyWrite(write, guard).catch(caught => caught);
    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', message: expect.stringMatching(/HTTP 400.*Campaign goals are not supported\. \[request-id: req-2\]/s) });
    expect(error.message).not.toMatch(/not confirmed/);
    expect(mutations(f)).toHaveLength(1);
  });

  it('runs through the shared policy gate: identical arguments, native re-validation and protected accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'google-conversion-goals-')); dirs.push(dir);
    const f = fixture(), runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const args = { account_id: A, ...(await setOp(f, ['11', '12'], { goal: { type: 'CUSTOM_GOAL', custom_conversion_goal_id: '701', expected_goal_hash: await goalHash(f) }, standard_goals: 'DISABLE_ALL' })).payload };
    const preview = await runtime.registry.call('google_set_campaign_conversion_goal', args, runtime.ctx) as any;
    expect(preview.pending_operation_id).toEqual(expect.any(String));
    await expect(runtime.registry.call('google_set_campaign_conversion_goal', { ...args, campaign_ids: ['11'], pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();
    await runtime.registry.call('google_set_campaign_conversion_goal', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);
    expect(mutations(f).map(call => call.body.validateOnly)).toEqual([true, true, false]);
    const protectedRuntime = await createContext({ engine: new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [A] }, new PendingStore(join(dir, 'protected')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    await expect(protectedRuntime.registry.call('google_create_custom_conversion_goal', { account_id: A, name: 'Goal', conversion_action_ids: ['501'] }, protectedRuntime.ctx)).rejects.toThrow(/protected/i);
    expect(mutations(f)).toHaveLength(3);
  });
});

import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Wire shapes verified against official v25 protos at googleapis/googleapis@492a18f4
// and live discovery revision 20261102. Native fixtures use JSON int64 strings.
const account = '1234567890', prefix = `customers/${account}`, experiment = `${prefix}/experiments/42`;
const guard = { forcePausedCreation: true };
type Row = Record<string, any>;
function campaign(id: string, type = 'BASE', amount = '1000000'): Row {
  return { campaign: { resourceName: `${prefix}/campaigns/${id}`, id, name: `Campaign ${id}`, status: type === 'DRAFT' ? 'ENABLED' : 'PAUSED', advertisingChannelType: 'SEARCH', experimentType: type, baseCampaign: `${prefix}/campaigns/7`, campaignBudget: `${prefix}/campaignBudgets/${id}01`, biddingStrategyType: 'MAXIMIZE_CONVERSIONS' }, budget: { resourceName: `${prefix}/campaignBudgets/${id}01`, id: `${id}01`, name: `Budget ${id}`, amountMicros: amount, status: 'ENABLED', period: 'DAILY', explicitlyShared: false, referenceCount: '1' } };
}
function fixture() {
  const state: Row = {
    customer: { resourceName: prefix, id: account, currencyCode: 'EUR', timeZone: 'Europe/Berlin' },
    experiment: { resourceName: experiment, experimentId: '42', name: 'Experiment fixture', suffix: '-qa', status: 'SETUP', type: 'SEARCH_CUSTOM', syncEnabled: false },
    arms: [{ resourceName: `${prefix}/experimentArms/42~100`, experiment, name: 'Control', control: true, trafficSplit: '50', campaigns: [`${prefix}/campaigns/7`] }, { resourceName: `${prefix}/experimentArms/42~101`, experiment, name: 'Treatment', control: false, trafficSplit: '50', inDesignCampaigns: [`${prefix}/campaigns/8`] }],
    campaigns: [campaign('7'), campaign('8', 'DRAFT')],
    budget: { resourceName: `${prefix}/campaignBudgets/900`, id: '900', name: 'Unused budget', status: 'ENABLED', period: 'DAILY', amountMicros: '2000000', explicitlyShared: false, referenceCount: '0' },
    operation: { name: `${prefix}/operations/native-operation`, done: false }, errors: {},
  };
  const calls: { url: URL; body: Row; init: RequestInit }[] = [];
  let responder: ((url: URL, body: Row) => unknown) | undefined;
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), body = url.hostname === 'oauth2.googleapis.com' ? {} : JSON.parse(String(init.body ?? '{}'));
    calls.push({ url, body, init });
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    if (url.pathname.endsWith('googleAds:search')) {
      const query = String(body.query);
      let rows: Row[];
      if (query.includes(' FROM customer ')) rows = [{ customer: state.customer }];
      else if (query.includes(' FROM experiment_arm ')) rows = state.arms.map((experimentArm: Row) => ({ experimentArm }));
      else if (query.includes(' FROM experiment ')) rows = [{ experiment: state.experiment }];
      else if (query.includes(' FROM campaign_budget ')) rows = [{ campaignBudget: state.budget }];
      else if (query.includes(' FROM campaign ')) rows = state.campaigns.filter((value: Row) => query.includes(`'${value.campaign.resourceName}'`)).map((value: Row) => ({ campaign: value.campaign, campaignBudget: value.budget }));
      else if (query.includes(' FROM ad_group_ad ')) rows = [];
      else throw new Error('Unhandled fixture GAQL');
      return Response.json({ results: rows });
    }
    const custom = responder?.(url, body);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (url.pathname.includes('/operations/')) return Response.json(state.operation);
    if (url.pathname.endsWith(':listExperimentAsyncErrors')) return Response.json(state.errors);
    if (body.validateOnly) return Response.json({});
    if (url.pathname.endsWith('googleAds:mutate')) return Response.json({ mutateOperationResponses: [{ experimentResult: { resourceName: experiment } }, ...state.arms.map((value: Row) => ({ experimentArmResult: { resourceName: value.resourceName } }))] });
    if (url.pathname.endsWith('/campaigns:mutate')) {
      for (const value of body.operations) Object.assign(state.campaigns.find((item: Row) => item.campaign.resourceName === value.update.resourceName).campaign, value.update);
    }
    if (body.operations) return Response.json({ results: body.operations.map((value: Row) => ({ resourceName: value.update?.resourceName ?? value.remove ?? `${prefix}/experimentArms/42~102` })) });
    return Response.json(url.pathname.endsWith(':scheduleExperiment') || url.pathname.endsWith(':promoteExperiment') ? state.operation : {});
  });
  const client = new GoogleAdsRestClient({ clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh' }, 'v25', fetcher as typeof fetch);
  const provider = new GoogleAdsProvider(client);
  return { state, calls, provider, client, respond(fn: typeof responder) { responder = fn; } };
}
const mutations = (f: ReturnType<typeof fixture>) => f.calls.filter(value => !value.url.pathname.endsWith('googleAds:search') && value.url.hostname !== 'oauth2.googleapis.com' && value.init.method === 'POST');
async function op(f: ReturnType<typeof fixture>, tool: string, extra: Row = {}): Promise<WriteOperation> {
  const context = await f.provider.experiments.context({ account_id: account, experiment_id: '42', ...(tool === 'google_graduate_experiment' ? { campaign_budget_id: '900' } : {}) });
  return { tool, provider: 'google', accountId: account, kind: tool.includes('create') || tool.includes('add_') ? 'create' : tool.includes('remove') ? 'remove' : 'update', payload: { experiment_id: '42', expected_experiment_hash: context.experiment_snapshot_hash, ...(tool === 'google_graduate_experiment' ? { expected_budget_hash: context.budget_snapshot_hash } : {}), ...extra } };
}
async function createOp(f: ReturnType<typeof fixture>, extra: Row = {}): Promise<WriteOperation> {
  const context = await f.provider.experiments.context({ account_id: account, base_campaign_id: '7' });
  return { tool: 'google_create_experiment', provider: 'google', accountId: account, kind: 'create', payload: { name: 'Experiment fixture', type: 'SEARCH_CUSTOM', suffix: '-qa', base_campaign_id: '7', expected_base_hash: context.base_snapshot_hash, control_name: 'Control', control_traffic_split_percent: 50, treatments: [{ name: 'Treatment', traffic_split_percent: 50 }], ...extra } };
}

describe('Google experiment setup and ownership', () => {
  it('validates atomic experiment/control/treatment creation without materializing or scheduling anything', async () => {
    const f = fixture(), preview = await f.provider.previewWrite(await createOp(f), guard), calls = mutations(f);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(`/v25/customers/${account}/googleAds:mutate`);
    expect(calls[0]!.body).toEqual({ validateOnly: true, partialFailure: false, responseContentType: 'MUTABLE_RESOURCE', mutateOperations: [
      { experimentOperation: { create: { resourceName: `${prefix}/experiments/-1`, name: 'Experiment fixture', type: 'SEARCH_CUSTOM', suffix: '-qa', status: 'SETUP' } } },
      { experimentArmOperation: { create: { experiment: `${prefix}/experiments/-1`, name: 'Control', control: true, trafficSplit: '50', campaigns: [`${prefix}/campaigns/7`] } } },
      { experimentArmOperation: { create: { experiment: `${prefix}/experiments/-1`, name: 'Treatment', control: false, trafficSplit: '50' } } },
    ] });
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [{ fromMicros: 0, toMicros: 1000000 }] });
    expect(preview.coercions[0]).toContain('PAUSED');
    expect(f.state.campaigns[1].campaign.status).toBe('ENABLED');
  });
  it('verifies native creation then validates/pauses only the generated owned draft and reads it back', async () => {
    const f = fixture(), result = await f.provider.applyWrite(await createOp(f), guard);
    expect(result).toMatchObject({ applied: true, details: { status: 'SETUP', scheduled: false, paused_by_policy: true, draft_campaign_ids: [`${prefix}/campaigns/8`] } });
    const writes = mutations(f);
    expect(writes.map(value => value.body.validateOnly)).toEqual([false, true, false]);
    expect(writes.slice(1).every(value => value.body.operations[0].update.resourceName === `${prefix}/campaigns/8`)).toBe(true);
    expect(f.state.campaigns[0].campaign.status).toBe('PAUSED');
    expect(f.calls.filter(value => String(value.body.query).includes(' FROM campaign ')).every(value => String(value.body.query).endsWith('PARAMETERS include_drafts=true'))).toBe(true);
  });
  it('reports acknowledged IDs on a follow-up failure without retrying creation or scheduling', async () => {
    const f = fixture(); f.state.arms[1].inDesignCampaigns = [];
    await expect(f.provider.applyWrite(await createOp(f), guard)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', details: { resource_ids: [experiment, `${prefix}/experimentArms/42~100`, `${prefix}/experimentArms/42~101`] } });
    expect(mutations(f)).toHaveLength(1);
  });
  it.each(['BASE', 'EXPERIMENT'])('never pauses a generated campaign reporting foreign type %s', async type => {
    const f = fixture(); f.state.campaigns[1].campaign.experimentType = type;
    await expect(f.provider.applyWrite(await createOp(f), guard)).rejects.toThrow('ownership/type mismatch');
    expect(mutations(f)).toHaveLength(1);
  });
  it('rejects stale base/experiment state and other-account campaign references before mutation', async () => {
    const f = fixture(), create = await createOp(f), update = await op(f, 'google_update_experiment', { name: 'New' });
    f.state.campaigns[0].budget.amountMicros = '1100000';
    await expect(f.provider.previewWrite(create, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(f.provider.previewWrite(update, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.state.arms[1].inDesignCampaigns = ['customers/9999999999/campaigns/8'];
    await expect(f.provider.experiments.context({ account_id: account, experiment_id: '42' })).rejects.toThrow('outside the selected account');
    expect(mutations(f)).toHaveLength(0);
  });
  it.each([{ control_traffic_split_percent: 40 }, { treatments: [{ name: 'Control', traffic_split_percent: 50 }] }, { video_experiment_subtype: 'ASSET' }, { start_date: '2026-12-31', end_date: '2026-12-01' }])('rejects malformed setup before native mutation: %j', async extra => {
    const f = fixture(); await expect(f.provider.previewWrite(await createOp(f, extra), guard)).rejects.toThrow();
    expect(mutations(f)).toHaveLength(0);
  });
  it('encodes Performance Max int64 settings and rejects mismatched bid targets', async () => {
    const f = fixture(); f.state.campaigns[0].campaign.advertisingChannelType = 'SHOPPING';
    const performance_max = { budget_amount_micros: 3000000, bidding_strategy_type: 'TARGET_ROAS', target_roas: 2.5 };
    await f.provider.previewWrite(await createOp(f, { type: 'PMAX_REPLACEMENT_SHOPPING', treatments: [{ name: 'Treatment', traffic_split_percent: 50, performance_max }] }), guard);
    expect(mutations(f)[0]!.body.mutateOperations[2].experimentArmOperation.create.performanceMaxExperimentArmInfo.experimentalPerformanceMaxCampaignSettings).toEqual({ budgetAmountMicros: '3000000', biddingStrategyType: 'TARGET_ROAS', targetRoas: 2.5 });
    await expect(f.provider.previewWrite(await createOp(f, { type: 'PMAX_REPLACEMENT_SHOPPING', treatments: [{ name: 'Treatment', traffic_split_percent: 50, performance_max: { ...performance_max, target_cpa_micros: 100 } }] }), guard)).rejects.toThrow('match the selected strategy');
    expect(mutations(f)).toHaveLength(1);
  });
  it('checks each newly generated treatment against its own approved bound even when native arm order differs', async () => {
    const f = fixture(); f.state.campaigns[0].campaign.advertisingChannelType = 'SHOPPING'; f.state.experiment.type = 'PMAX_REPLACEMENT_SHOPPING';
    f.state.arms[0].trafficSplit = '20'; f.state.arms[1].trafficSplit = '40';
    const other = { ...f.state.arms[1], resourceName: `${prefix}/experimentArms/42~99`, name: 'Higher budget', inDesignCampaigns: [`${prefix}/campaigns/9`] };
    f.state.arms.push(other); f.state.campaigns.push(campaign('9', 'DRAFT', '5000000'));
    f.state.campaigns[1].budget.amountMicros = '2000000';
    const payload = { type: 'PMAX_REPLACEMENT_SHOPPING', control_traffic_split_percent: 20, treatments: [{ name: 'Treatment', traffic_split_percent: 40, performance_max: { budget_amount_micros: 1000000, bidding_strategy_type: 'MAXIMIZE_CONVERSIONS' } }, { name: 'Higher budget', traffic_split_percent: 40, performance_max: { budget_amount_micros: 5000000, bidding_strategy_type: 'MAXIMIZE_CONVERSIONS' } }] };
    await expect(f.provider.applyWrite(await createOp(f, payload), guard)).rejects.toThrow('exceeds the approved plan');
    expect(f.state.campaigns.slice(1).every((value: Row) => value.campaign.status === 'PAUSED')).toBe(true);
    expect(mutations(f)).toHaveLength(3);
  });
});

describe('Google experiment edits and native lifecycle', () => {
  it('uses exact experiment metadata masks and preserves immutable fields', async () => {
    const f = fixture();
    await f.provider.previewWrite(await op(f, 'google_update_experiment', { name: 'Changed', description: '', start_date: '2026-12-01', goals: [{ metric: 'CONVERSIONS', direction: 'INCREASE' }] }), guard);
    expect(mutations(f)[0]!.body.operations).toEqual([{ update: { resourceName: experiment, name: 'Changed', description: '', startDate: '2026-12-01', goals: [{ metric: 'CONVERSIONS', direction: 'INCREASE' }] }, updateMask: 'name,description,start_date,goals' }]);
    expect(mutations(f)[0]!.body.validateOnly).toBe(true);
  });
  it('updates owned SETUP arm names and shares atomically without changing campaign/control assignments', async () => {
    const f = fixture();
    await f.provider.previewWrite(await op(f, 'google_update_experiment_arms', { arms: [{ arm_id: '100', traffic_split_percent: 40 }, { arm_id: '101', name: 'Variant', traffic_split_percent: 60 }] }), guard);
    expect(mutations(f)[0]!.body).toEqual({ partialFailure: false, validateOnly: true, operations: [{ update: { resourceName: `${prefix}/experimentArms/42~100`, trafficSplit: '40' }, updateMask: 'traffic_split' }, { update: { resourceName: `${prefix}/experimentArms/42~101`, name: 'Variant', trafficSplit: '60' }, updateMask: 'name,traffic_split' }] });
  });
  it('rejects foreign/duplicate arms, invalid totals and edits outside SETUP', async () => {
    const f = fixture();
    for (const arms of [[{ arm_id: '999', name: 'Foreign' }], [{ arm_id: '101', name: 'One' }, { arm_id: '101', name: 'Two' }], [{ arm_id: '101', traffic_split_percent: 60 }]]) await expect(f.provider.previewWrite(await op(f, 'google_update_experiment_arms', { arms }), guard)).rejects.toThrow();
    f.state.experiment.status = 'ENABLED';
    await expect(f.provider.previewWrite(await op(f, 'google_update_experiment_arms', { arms: [{ arm_id: '101', name: 'Variant' }] }), guard)).rejects.toThrow('SETUP');
    expect(mutations(f)).toHaveLength(0);
  });
  it('adds a treatment and rebalances existing arms in one native atomic validateOnly request', async () => {
    const f = fixture(), preview = await f.provider.previewWrite(await op(f, 'google_add_experiment_arms', { existing_arms: [{ arm_id: '100', traffic_split_percent: 40 }, { arm_id: '101', traffic_split_percent: 30 }], treatments: [{ name: 'Second variant', traffic_split_percent: 30 }] }), guard);
    const body = mutations(f)[0]!.body;
    expect(body).toMatchObject({ validateOnly: true, partialFailure: false });
    expect(body.operations).toHaveLength(3);
    expect(body.operations[2]).toEqual({ create: { experiment, control: false, name: 'Second variant', trafficSplit: '30' } });
    expect(preview).toMatchObject({ serverValidated: false, budgetDeltas: [{ fromMicros: 0, toMicros: 1000000 }] });
  });
  it('confirms added arm ownership and pauses only its new draft after the native atomic mutation', async () => {
    const f = fixture();
    f.respond((url, body) => {
      if (!url.pathname.endsWith('/experimentArms:mutate') || body.validateOnly) return undefined;
      f.state.arms[0].trafficSplit = '40'; f.state.arms[1].trafficSplit = '30';
      f.state.arms.push({ resourceName: `${prefix}/experimentArms/42~102`, experiment, name: 'Second variant', control: false, trafficSplit: '30', inDesignCampaigns: [`${prefix}/campaigns/10`] });
      f.state.campaigns.push(campaign('10', 'DRAFT'));
      return undefined;
    });
    const result = await f.provider.applyWrite(await op(f, 'google_add_experiment_arms', { existing_arms: [{ arm_id: '100', traffic_split_percent: 40 }, { arm_id: '101', traffic_split_percent: 30 }], treatments: [{ name: 'Second variant', traffic_split_percent: 30 }] }), guard);
    expect(result).toMatchObject({ details: { status: 'SETUP', scheduled: false, draft_campaign_ids: [`${prefix}/campaigns/10`] } });
    expect(mutations(f).map(value => value.body.validateOnly)).toEqual([false, true, false]);
    expect(mutations(f)[2]!.body.operations[0].update.resourceName).toBe(`${prefix}/campaigns/10`);
    expect(f.state.campaigns[1].campaign.status).toBe('ENABLED');
  });
  it('rejects an acknowledged arm from another experiment before attempting draft follow-up', async () => {
    const f = fixture(); f.respond((url, body) => url.pathname.endsWith('/experimentArms:mutate') && !body.validateOnly ? { results: [{ resourceName: `${prefix}/experimentArms/77~100` }] } : undefined);
    await expect(f.provider.applyWrite(await op(f, 'google_update_experiment_arms', { arms: [{ arm_id: '100', name: 'Renamed control' }] }), guard)).rejects.toThrow('receipt was not confirmed');
    expect(mutations(f)).toHaveLength(1);
  });
  it('removes only the selected account-owned arms and disallows a surviving set without a control', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(await op(f, 'google_remove_experiment_arms', { arm_ids: ['100'], remaining_arms: [] }), guard)).rejects.toThrow('one control');
    await f.provider.previewWrite(await op(f, 'google_remove_experiment_arms', { arm_ids: ['100', '101'], remaining_arms: [] }), guard);
    expect(mutations(f)[0]!.body.operations).toEqual([{ remove: `${prefix}/experimentArms/42~100` }, { remove: `${prefix}/experimentArms/42~101` }]);
  });
  it('blocks scheduling before any native action under paused_creation', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(await op(f, 'google_schedule_experiment', { confirm_serving_changes: true }), guard)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(mutations(f)).toHaveLength(0);
  });
  it.each(['google_schedule_experiment', 'google_promote_experiment'])('previews %s natively and distinguishes asynchronous acceptance from completion', async tool => {
    const f = fixture(), operation = await op(f, tool, { confirm_serving_changes: true });
    const preview = await f.provider.previewWrite(operation, { forcePausedCreation: false });
    expect(preview.serverValidated).toBe(true);
    expect(mutations(f)[0]!.body).toEqual({ validateOnly: true });
    const result = await f.provider.applyWrite(operation, { forcePausedCreation: false });
    expect(result).toMatchObject({ details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, experiment_id: '42', next_tool: 'google_experiment_operation' } });
    expect(mutations(f).map(value => value.body.validateOnly)).toEqual([true, false]);
  });
  it.each([`${prefix}/operations/../other`, `${prefix}/operations/..`, 'customers/9999999999/operations/foreign'])('rejects an unsafe lifecycle acknowledgement without polling or retry: %s', async value => {
    const f = fixture(); f.state.operation.name = value;
    await expect(f.provider.applyWrite(await op(f, 'google_promote_experiment', { confirm_serving_changes: true }), guard)).rejects.toThrow('acknowledgement was not confirmed');
    expect(mutations(f)).toHaveLength(1);
    expect(f.calls.some(call => call.url.pathname.includes('/operations/'))).toBe(false);
  });
  it('validates native end/remove actions without campaign status writes', async () => {
    const f = fixture();
    await f.provider.previewWrite(await op(f, 'google_end_experiment'), guard);
    await f.provider.previewWrite(await op(f, 'google_remove_experiment'), guard);
    expect(mutations(f).map(value => value.url.pathname)).toEqual([`/v25/${experiment}:endExperiment`, `/v25/customers/${account}/experiments:mutate`]);
    expect(mutations(f)[1]!.body.operations).toEqual([{ remove: experiment }]);
    expect(mutations(f).every(value => value.body.validateOnly)).toBe(true);
  });
  it('graduates only a verified materialized treatment using a current unused budget and micros delta', async () => {
    const f = fixture(); f.state.arms[1].campaigns = [`${prefix}/campaigns/8`]; f.state.arms[1].inDesignCampaigns = []; f.state.campaigns[1].campaign.experimentType = 'EXPERIMENT';
    const extra = { confirm_serving_changes: true, campaign_id: '8', campaign_budget_id: '900' }, operation = await op(f, 'google_graduate_experiment', extra);
    const preview = await f.provider.previewWrite(operation, guard);
    expect(preview.budgetDeltas).toEqual([{ target: 'graduated campaign 8 daily budget', fromMicros: 1000000, toMicros: 2000000 }]);
    expect(mutations(f)[0]!.body).toEqual({ validateOnly: true, campaignBudgetMappings: [{ experimentCampaign: `${prefix}/campaigns/8`, campaignBudget: `${prefix}/campaignBudgets/900` }] });
    f.state.budget.referenceCount = '1';
    await expect(f.provider.previewWrite(await op(f, 'google_graduate_experiment', extra), guard)).rejects.toThrow('unused');
    await expect(f.provider.previewWrite(operation, guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    expect(mutations(f)).toHaveLength(1);
  });
});

describe('Google experiment observation, adapters and policy', () => {
  it('lists native configuration with explicit removed filtering and rejects a nonadvancing ID continuation', async () => {
    const f = fixture();
    expect(await f.provider.experiments.list({ account_id: account, limit: 25 })).toMatchObject({ experiments: [{ experimentId: '42', status: 'SETUP' }], truncated: false });
    expect(f.calls.at(-1)!.body.query).toContain("experiment.status != 'REMOVED'");
    await expect(f.provider.experiments.list({ account_id: account, limit: 1, after_experiment_id: '42', include_removed: true })).rejects.toThrow('did not advance');
    expect(f.calls.at(-1)!.body.query).toContain('experiment.experiment_id > 42');
    expect(f.calls.at(-1)!.body.query).not.toContain("!= 'REMOVED'");
  });
  it('preserves missing-operation uncertainty and rejects inconsistent native completion metadata', async () => {
    const f = fixture();
    expect(await f.provider.experiments.operation({ account_id: account, experiment_id: '42' })).toMatchObject({ state: 'NO_OPERATION_REPORTED' });
    f.state.experiment.longRunningOperation = f.state.operation.name;
    f.state.operation.response = {};
    await expect(f.provider.experiments.operation({ account_id: account, experiment_id: '42' })).rejects.toThrow('completion result mismatch');
    f.state.operation.done = true; f.state.operation.metadata = { experiment: `${prefix}/experiments/77` };
    await expect(f.provider.experiments.operation({ account_id: account, experiment_id: '42' })).rejects.toThrow('identity');
  });
  it.each([{ done: false, state: 'PROCESSING' }, { done: true, response: {}, state: 'SUCCEEDED' }, { done: true, error: { code: 3, message: 'private native echo' }, state: 'FAILED' }, { done: true, state: 'UNKNOWN' }])('reports actual current native operation state: %j', async value => {
    const f = fixture(); f.state.experiment.longRunningOperation = f.state.operation.name;
    const { state, ...response } = value; Object.assign(f.state.operation, response);
    const result = await f.provider.experiments.operation({ account_id: account, experiment_id: '42' });
    expect(result).toMatchObject({ state, done: value.done });
    expect(JSON.stringify(result)).not.toContain('private native echo');
    expect(mutations(f)).toHaveLength(0);
  });
  it('refuses foreign/current-operation mismatches and never accepts an arbitrary caller operation URL', async () => {
    const f = fixture(); f.state.experiment.longRunningOperation = 'customers/9999999999/operations/foreign';
    await expect(f.provider.experiments.operation({ account_id: account, experiment_id: '42' })).rejects.toThrow('selected account');
    expect(f.calls.some(value => value.url.pathname.includes('/operations/'))).toBe(false);
    f.state.experiment.longRunningOperation = `${prefix}/operations/native-operation`; f.state.operation.name = `${prefix}/operations/other`;
    await expect(f.provider.experiments.operation({ account_id: account, experiment_id: '42' })).rejects.toThrow('mismatch');
    const tool = googleTools(f.provider).find(value => value.name === 'google_experiment_operation')!;
    // No request-provided operation name is consumed; this tool derives it from native context.
    expect(Object.keys(tool.input.parse({ account_id: account, experiment_id: '42', operation_name: 'foreign' }))).not.toContain('operation_name');
  });
  it('encodes native error pagination and returns diagnostics without sensitive value echoes', async () => {
    const f = fixture(); f.state.errors = { errors: [{ code: 3, message: 'private native echo', details: [{ errors: [{ message: 'secret value', errorCode: { experimentError: 'INVALID_STATUS' }, location: { fieldPathElements: [{ fieldName: 'experiment' }, { fieldName: 'status' }] } }] }] }], nextPageToken: 'next+token' };
    const result = await f.provider.experiments.asyncErrors({ account_id: account, experiment_id: '42', page_size: 10, page_token: 'old+/=' });
    expect(result).toMatchObject({ truncated: true, next_page_token: 'next+token', errors: [{ code: 3, errors: [{ codes: ['experimentError.INVALID_STATUS'], fields: ['experiment', 'status'] }] }] });
    expect(f.calls.at(-1)!.url.searchParams.get('pageToken')).toBe('old+/=');
    expect(JSON.stringify(result)).not.toMatch(/private native echo|secret value/);
    f.state.errors.nextPageToken = 'old+/=';
    await expect(f.provider.experiments.asyncErrors({ account_id: account, experiment_id: '42', page_size: 10, page_token: 'old+/=' })).rejects.toThrow('nonadvancing');
  });
  it('adds the explicit draft parameter alongside existing GAQL parameters and leaves normal queries unchanged', async () => {
    const f = fixture();
    await f.provider.gaqlSearch({ customer_id: account, resource: 'customer', fields: ['customer.id'], include_drafts: true });
    expect(f.calls.at(-1)!.body.query).toBe('SELECT customer.id FROM customer LIMIT 200 PARAMETERS omit_unselected_resource_names=true, include_drafts=true');
    await f.provider.gaqlSearch({ customer_id: account, resource: 'customer', fields: ['customer.id'] });
    expect(f.calls.at(-1)!.body.query).not.toContain('include_drafts');
    await f.provider.listAds({ account_id: account, limit: 10, include_drafts: true });
    expect(f.calls.at(-1)!.body.query).toContain('PARAMETERS include_drafts=true');
  });
  it('preserves large decimal campaign IDs in draft-aware mutation preflights', async () => {
    const f = fixture();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com')) return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
      const body = JSON.parse(String(init?.body));
      if (String(input).includes('googleAds:search')) {
        expect(body.query).toContain('campaign.id = 9007199254740993');
        expect(body.query).toContain('PARAMETERS include_drafts=true');
        return Response.json({ results: [{ campaign: { name: 'Draft', status: 'PAUSED' } }] });
      }
      expect(body.operations[0].update.resourceName).toBe(`${prefix}/campaigns/9007199254740993`);
      expect(body.validateOnly).toBe(true);
      return Response.json({});
    });
    const provider = new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'x', clientSecret: 'x', refreshToken: 'x' }, 'v25', fetcher as typeof fetch));
    await provider.previewWrite({ tool: 'google_set_campaign_status', provider: 'google', accountId: account, kind: 'update', payload: { campaign_id: '9007199254740993', status: 'PAUSED' } }, guard);
    const before = f.calls.length;
    await expect(f.provider.previewWrite({ tool: 'google_set_campaign_status', provider: 'google', accountId: account, kind: 'update', payload: { campaign_id: '7 OR 1=1', status: 'PAUSED' } }, guard)).rejects.toThrow('invalid campaign ID');
    expect(f.calls).toHaveLength(before);
  });
  it('requires shared preview/apply policy, exact arguments, one-use tokens and protected-account authorization', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>(), audits: unknown[] = [];
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(key) { return pending.get(key); }, async delete(key) { pending.delete(key); } }, { async append(value) { audits.push(value); } });
    const rt = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const operation = await op(f, 'google_update_experiment', { name: 'Changed' }), args = { account_id: account, ...operation.payload };
    const preview = await rt.registry.call(operation.tool, args, rt.ctx) as { pending_operation_id: string };
    expect(mutations(f).every(value => value.body.validateOnly)).toBe(true);
    await expect(rt.registry.call(operation.tool, { ...args, name: 'Other', pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await rt.registry.call(operation.tool, { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx);
    await expect(rt.registry.call(operation.tool, { ...args, pending_operation_id: preview.pending_operation_id }, rt.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
    expect(mutations(f).filter(value => !value.body.validateOnly)).toHaveLength(1);
    expect(audits.length).toBeGreaterThan(0);
    const protectedEngine = new PolicyEngine({ ...DEFAULT_POLICY, protected_accounts: [account] }, { async sweep() {}, async put() {}, async get() { return undefined; }, async delete() {} }, { async append() {} });
    const protectedRt = await createContext({ engine: protectedEngine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    await expect(protectedRt.registry.call(operation.tool, args, protectedRt.ctx)).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    const tools = googleTools(f.provider);
    expect(new Set(tools.map(value => value.name)).size).toBe(tools.length);
    expect(tools.find(value => value.name === 'google_create_experiment')!.annotations).toMatchObject({ readOnly: false, destructive: false });
    expect(tools.find(value => value.name === 'google_remove_experiment')!.annotations).toMatchObject({ readOnly: false, destructive: true });
  });
});

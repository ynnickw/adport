import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
export type GeneralRow = Record<string, any>;
export type GeneralCall = { path: string; body: GeneralRow; method: string; headers: RequestInit['headers'] };
export const GENERAL_ACCOUNT = '777', GENERAL_CAMPAIGN = '9', GENERAL_GROUP = '8';
export const campaignSelection = { type: 'Campaign' as const, campaign_id: GENERAL_CAMPAIGN }, groupSelection = { type: 'AdGroup' as const, campaign_id: GENERAL_CAMPAIGN, ad_group_id: GENERAL_GROUP };
export const generalCriterion = (prefix: 'Campaign' | 'AdGroup', id: string, type: string, data: GeneralRow, bid?: number, negative = false): GeneralRow => ({ Id: id, [`${prefix}Id`]: prefix === 'Campaign' ? GENERAL_CAMPAIGN : GENERAL_GROUP, Status: 'Active', Type: `${negative ? 'Negative' : 'Biddable'}${prefix}Criterion`, Criterion: { Type: type + 'Criterion', ...data }, ...(bid === undefined ? {} : { CriterionBid: { Type: 'BidMultiplier', Multiplier: bid } }) });
export function generalFixture(override?: (call: GeneralCall) => unknown) {
  const state = { account: { Id: GENERAL_ACCOUNT, ParentCustomerId: '9001', CurrencyCode: 'EUR', TimeZone: 'AmsterdamBerlinBernRomeStockholmVienna', AccountLifeCycleStatus: 'Active' } as GeneralRow, campaign: { Id: GENERAL_CAMPAIGN, Name: '<Native QA campaign>', Status: 'Paused', CampaignType: 'Search', DailyBudget: 1, BudgetId: null, BudgetType: 'DailyBudgetStandard', BiddingScheme: { Type: 'EnhancedCpc' }, Settings: [{ Type: 'TargetSetting', Details: [{ CriterionTypeGroup: 'Audience', TargetAndBid: false }] }], AdScheduleUseSearcherTimeZone: false } as GeneralRow, group: { Id: GENERAL_GROUP, Name: '<Native QA group>', Status: 'Paused', AdGroupType: 'SearchStandard', Language: 'English', CpcBid: { Amount: 0.05 }, AdScheduleUseSearcherTimeZone: true } as GeneralRow,
    campaignCriteria: [generalCriterion('Campaign', '101', 'Location', { LocationId: '190' }, 0), generalCriterion('Campaign', '102', 'LocationIntent', { IntentOption: 'PeopleIn' }), generalCriterion('Campaign', '103', 'DayTime', { Day: 'Monday', FromHour: 9, FromMinute: 'Zero', ToHour: 17, ToMinute: 'Zero' }, 10)], ownCriteria: [] as GeneralRow[] };
  const calls: GeneralCall[] = [];let nextId = 400;
  const client = new MicrosoftAdsClient({ clientId: 'inert', developerToken: 'inert', refreshToken: 'inert' }, undefined, async (raw, init = {}) => {
    const url = new URL(String(raw));if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), body: JSON.parse(String(init.body ?? '{}')), method: init.method ?? 'POST', headers: init.headers };calls.push(call);
    const custom = override?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [state.account] });
    if (call.path === 'Account/Query') return Response.json({ Account: state.account });
    if (['Campaigns/QueryByAccountId', 'Campaigns/QueryByIds'].includes(call.path)) return Response.json({ Campaigns: [state.campaign] });
    if (call.path === 'AdGroups/QueryByIds') return Response.json({ AdGroups: call.body.CampaignId === GENERAL_CAMPAIGN && call.body.AdGroupIds?.includes(GENERAL_GROUP) ? [state.group] : [] });
    const prefix = call.path.startsWith('AdGroup') ? 'AdGroup' : 'Campaign', key = prefix === 'AdGroup' ? 'ownCriteria' : 'campaignCriteria', values = state[key];
    if (call.path === prefix + 'Criterions/QueryByIds') return Response.json({ [prefix + 'Criterions']: values.filter(value => value.Criterion.Type.replace(/Criterion$/, '') === call.body.CriterionType) });
    if (call.path === prefix + 'Criterions') {
      if (call.method === 'POST') { const ids = call.body[prefix + 'Criterions'].map((value: GeneralRow) => { const Id = String(nextId++);values.push({ ...value, Id, Status: 'Active' });return Id; });return Response.json({ [prefix + 'CriterionIds']: ids, NestedPartialErrors: [] }); }
      if (call.method === 'PUT') { for (const value of call.body[prefix + 'Criterions']) { const current = values.find(item => item.Id === value.Id)!;if (value.Criterion) current.Criterion = value.Criterion;if (value.CriterionBid) current.CriterionBid = value.CriterionBid; }return Response.json({ NestedPartialErrors: [] }); }
      if (call.method === 'DELETE') { state[key] = values.filter(value => !call.body[prefix + 'CriterionIds'].includes(value.Id));return Response.json({ PartialErrors: [] }); }
    }
    if (call.method === 'PUT' && call.path === (prefix === 'AdGroup' ? 'AdGroups' : 'Campaigns')) { Object.assign(prefix === 'AdGroup' ? state.group : state.campaign, call.body[call.path][0]);return Response.json({ PartialErrors: [] }); }
    throw new Error(`Unexpected general targeting endpoint ${call.method} ${call.path}`);
  });
  const provider = new MicrosoftAdsProvider(client);
  return { provider, state, calls, writes: () => calls.filter(value => !value.path.includes('/') && ['Campaigns', 'AdGroups', 'CampaignCriterions', 'AdGroupCriterions'].includes(value.path)), async args(change: GeneralRow, target: typeof campaignSelection | typeof groupSelection = groupSelection): Promise<GeneralRow> { const context = await provider.generalTargeting.list({ account_id: GENERAL_ACCOUNT, target });return { target, expected_context_hash: context.context_hash, acknowledge_delivery_effects: true, change }; } };
}

import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';

export type OfflineRow = Record<string, any>;
export type OfflineCall = { path: string; method: string; body: OfflineRow; headers: RequestInit['headers'] };
export const OFFLINE_ACCOUNT = '777', OFFLINE_NOW = '2026-11-06T12:00:00Z';
export const offlineEvent = { microsoft_click_id: 'private-click-identity-1', conversion_time: '2026-11-05T10:00:00.1234567Z', conversion_value: 12.34, conversion_currency_code: 'EUR' };
export function offlineFixture(override?: (call: OfflineCall) => unknown) {
  const calls: OfflineCall[] = [], state: OfflineRow = { auto: true, parent: '9001', available: true, goal: { Id: '100', Type: 'OfflineConversion', Name: '<Owned offline goal>', Scope: 'Account', Status: 'Active', IsExternallyAttributed: false, IsEnhancedConversionsEnabled: true, ExcludeFromBidding: false, CountType: 'All', ConversionWindowInMinutes: 43200, Revenue: { Type: 'VariableValue', Value: 3.5, CurrencyCode: 'EUR' }, TrackingStatus: 'RecordingConversions' } };
  const client = new MicrosoftAdsClient({ clientId: 'inert', developerToken: 'inert', refreshToken: 'inert' }, undefined, async (raw, init = {}) => {
    const url = new URL(String(raw));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'inert', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')), headers: init.headers };calls.push(call);
    const custom = override?.(call);if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: state.available ? [{ Id: OFFLINE_ACCOUNT, ParentCustomerId: state.parent }] : [] });
    if (call.path === 'AccountProperties/Query') return Response.json({ AccountProperties: [{ Name: 'MSCLKIDAutoTaggingEnabled', Value: String(state.auto) }] });
    if (call.path === 'ConversionGoals/QueryByIds') return Response.json({ ConversionGoals: [state.goal] });
    if (['OfflineConversions/Apply', 'OfflineConversionAdjustments/Apply'].includes(call.path)) return Response.json({ PartialErrors: [] });
    throw new Error(`Unexpected offline test endpoint ${call.path}`);
  });
  const provider = new MicrosoftAdsProvider(client);
  return { client, provider, state, calls, writes: () => calls.filter(call => call.path.endsWith('/Apply')), async args(extra: OfflineRow = {}): Promise<OfflineRow> { return { goal_id: '100', expected_goal_hash: (await provider.conversions.get(OFFLINE_ACCOUNT, '100', 'OfflineConversion')).snapshot_hash, acknowledge_measurement_effects: true, conversions: [offlineEvent], ...extra }; } };
}

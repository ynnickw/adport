import { describe, expect, it } from 'vitest';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// Wire contracts: MicrosoftDocs/Advertising@fdee2fcf, confirmed against live v13
// report reads on 2026-11-04. No conversion events or customer records are sent.
type Row = Record<string, unknown>;
type Call = { path: string; method: string; body: Row; headers: RequestInit['headers'] };
const date_range = { start_utc: '2026-11-01T00:00:00Z', end_utc: '2026-11-03T00:00:00Z' };
const base = { account_id: '777', date_range };
function fixture(override?: (call: Call) => unknown) {
  const calls: Call[] = [];
  const client = new MicrosoftAdsClient({ developerToken: 'fixture-dev', clientId: 'fixture-client', refreshToken: 'fixture-refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    const call = { path: url.pathname.replace(/^.*\/v13\//, ''), method: init.method ?? 'POST', body: JSON.parse(String(init.body ?? '{}')) as Row, headers: init.headers }; calls.push(call);
    const custom = override?.(call); if (custom !== undefined) return Response.json(custom);
    if (call.path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (call.path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: '777', ParentCustomerId: '9001' }] });
    if (call.path === 'ConversionGoals/QueryByIds') return Response.json({ ConversionGoals: (call.body.ConversionGoalIds as string[]).map(Id => ({ Id, Type: 'OfflineConversion', Scope: 'Account' })), PartialErrors: [] });
    if (call.path === 'OfflineConversionReports/Query') return Response.json({ DailySummaries: [] });
    if (call.path === 'OfflineConversionReport/QueryByGoalIds') return Response.json({ OfflineGoalConversionSummaries: [], PartialErrors: [] });
    throw new Error(`Unexpected native operation: ${call.method} ${call.path}`);
  });
  const provider = new MicrosoftAdsProvider(client), tools = microsoftTools(provider);
  return { provider, calls, tools, tool: (name: string) => tools.find(value => value.name === name)! };
}

describe('Microsoft offline conversion report reads', () => {
  it('registers lazy read tools and validates UTC intervals, goal limits and native channel flags', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    const daily = tools.find(value => value.name === 'microsoft_offline_conversion_reports')!, goal = tools.find(value => value.name === 'microsoft_offline_conversion_goal_report')!;
    expect(daily.annotations.readOnly).toBe(true); expect(goal.annotations.readOnly).toBe(true);
    expect(goal.input.safeParse({ ...base, goal_ids: ['100'], upload_channels: ['CampaignManagementAPI', 'BulkAPI'] }).success).toBe(true);
    for (const value of [{ goal_ids: [] }, { goal_ids: ['100', '100'] }, { goal_ids: Array.from({ length: 21 }, (_, index) => String(index + 1)) }, { goal_ids: ['100'], upload_channels: ['CSV'] }, { goal_ids: ['100'], upload_channels: ['Unknown', 'WebUpload'] }, { goal_ids: ['100'], date_range: { ...date_range, end_utc: '2026-11-09T00:00:00Z' } }, { goal_ids: ['100'], date_range: { ...date_range, end_utc: '2026-10-31T00:00:00Z' } }, { goal_ids: ['100'], date_range: { ...date_range, end_utc: '2026-11-03T07:00:00+07:00' } }]) expect(goal.input.safeParse({ ...base, ...value }).success).toBe(false);
  });

  it('uses scoped POST query wire shapes and preserves an empty report without inventing zero rows', async () => {
    const f = fixture();
    expect(await f.provider.offlineReports.daily(base)).toMatchObject({ account_id: '777', date_range, rows: [] });
    expect(await f.provider.offlineReports.goals({ ...base, goal_ids: ['100'] })).toMatchObject({ rows: [], errors: [], not_returned_goal_ids: ['100'] });
    const report = f.calls.find(value => value.path === 'OfflineConversionReports/Query')!;
    expect(report).toMatchObject({ method: 'POST', body: { StartDateUtc: date_range.start_utc, EndDateUtc: date_range.end_utc }, headers: { CustomerAccountId: '777', CustomerId: '9001' } });
    expect(f.calls.find(value => value.path === 'ConversionGoals/QueryByIds')!.body).toEqual({ ConversionGoalIds: ['100'], ConversionGoalTypes: 'OfflineConversion' });
    expect(f.calls.at(-1)).toMatchObject({ path: 'OfflineConversionReport/QueryByGoalIds', method: 'POST', body: { StartDateUtc: date_range.start_utc, EndDateUtc: date_range.end_utc, GoalIds: ['100'], UploadChannelFilter: null } });
    expect(f.calls.every(value => value.method === 'POST' && /\/Query|\/Search/.test(value.path))).toBe(true);
  });

  it('strips signed download URLs and pilot event/customer fields while preserving native dates and missing counts', async () => {
    const f = fixture(call => call.path === 'OfflineConversionReports/Query' ? { DailySummaries: [{ UploadDate: '2026-11-02T00:00:00', SuccessCount: '0', FailureCount: null, FileUrl: 'https://files.example/private-signed-token', FileUrlExpiryTimeUtc: '2026-11-05T00:00:00Z', MSClickId: 'private-click', HashedEmailAddress: 'private-hash', ConversionTime: 'private-time' }] } : undefined);
    const value = await f.provider.offlineReports.daily(base);
    expect(value.rows).toEqual([{ UploadDate: '2026-11-02T00:00:00', SuccessCount: '0', FailureCount: null, FileUrlExpiryTimeUtc: '2026-11-05T00:00:00Z', file_available: true }]);
    expect(JSON.stringify(value)).not.toMatch(/private-|MSClickId|HashedEmailAddress|ConversionTime/);
    const output = f.tool('microsoft_offline_conversion_reports').output!;
    expect(output.parse(value)).toEqual(value);
  });

  it('keeps long counts and decimal ratios exact, verifies nested goal IDs and uses REST CSV channel flags', async () => {
    const native = { GoalId: 100, ConversionName: 'Offline goal', OverallSuccessCount: '9007199254740993', OverallUnattributedCount: '0', OverallSuccessRate: '0.000001', OverallAlerts: [{ Count: '3', UnattributedReason: 'GoalNotFound', MSClickId: 'private-click' }], DailySummaries: [{ GoalId: '100', UploadDate: '2026-11-02T00:00:00Z', SuccessCount: 0, UnattributedCount: null, Alerts: [], HashedPhoneNumber: 'private-phone' }], FileUrl: 'private-url' };
    const f = fixture(call => call.path === 'OfflineConversionReport/QueryByGoalIds' ? { OfflineGoalConversionSummaries: [native], PartialErrors: [] } : undefined);
    const value = await f.provider.offlineReports.goals({ ...base, goal_ids: ['100'], upload_channels: ['CampaignManagementAPI', 'BulkAPI'] });
    expect(f.calls.at(-1)!.body.UploadChannelFilter).toBe('CampaignManagementAPI, BulkAPI');
    expect(value.rows[0]).toMatchObject({ GoalId: '100', OverallSuccessCount: '9007199254740993', OverallSuccessRate: '0.000001', DailySummaries: [{ GoalId: '100', SuccessCount: 0, UnattributedCount: null }] });
    expect(value.not_returned_goal_ids).toEqual([]); expect(JSON.stringify(value)).not.toContain('private-');
    expect(f.tool('microsoft_offline_conversion_goal_report').output!.parse(value)).toEqual(value);
  });

  it('returns successful summaries and indexed partial errors without leaking native error details', async () => {
    const f = fixture(call => call.path === 'OfflineConversionReport/QueryByGoalIds' ? { OfflineGoalConversionSummaries: [{ GoalId: '100', OverallSuccessCount: '0' }], PartialErrors: [null, { Index: 1, Code: 123, ErrorCode: 'GoalNotFound', Message: 'private-message', Details: 'private-details' }] } : undefined);
    const value = await f.provider.offlineReports.goals({ ...base, goal_ids: ['100', '101'] });
    expect(value.errors).toEqual([{ index: 1, goal_id: '101', code: 123, error_code: 'GoalNotFound' }]); expect(value.not_returned_goal_ids).toEqual(['101']); expect(value.rows[0]!.OverallSuccessCount).toBe('0'); expect(JSON.stringify(value)).not.toContain('private-');
  });

  it('rejects unavailable or foreign goals before requesting statistics', async () => {
    for (const ConversionGoals of [[], [{ Id: '999', Type: 'OfflineConversion' }], [{ Id: '100', Type: 'Event' }]]) {
      const f = fixture(call => call.path === 'ConversionGoals/QueryByIds' ? { ConversionGoals } : undefined);
      await expect(f.provider.offlineReports.goals({ ...base, goal_ids: ['100'] })).rejects.toThrow('not all available'); expect(f.calls.some(value => value.path === 'OfflineConversionReport/QueryByGoalIds')).toBe(false);
    }
  });

  it('rejects mismatched native identities, unsafe numeric counts and malformed partial receipts', async () => {
    for (const response of [{ OfflineGoalConversionSummaries: [{ GoalId: '999' }] }, { OfflineGoalConversionSummaries: [{ GoalId: '100', DailySummaries: [{ GoalId: '999', UploadDate: 'today' }] }] }, { OfflineGoalConversionSummaries: [{ GoalId: '100', OverallSuccessCount: Number.MAX_SAFE_INTEGER + 1 }] }, { OfflineGoalConversionSummaries: [], PartialErrors: [{ Index: 20, Code: 123 }] }, { OfflineGoalConversionSummaries: [], PartialErrors: [{}] }, { OfflineGoalConversionSummaries: [], NestedPartialErrors: [{ Code: 123 }] }, {}]) {
      const f = fixture(call => call.path === 'OfflineConversionReport/QueryByGoalIds' ? response : undefined);
      await expect(f.provider.offlineReports.goals({ ...base, goal_ids: ['100'] })).rejects.toThrow();
    }
    const f = fixture(call => call.path === 'OfflineConversionReports/Query' ? { DailySummaries: [{ UploadDate: 'today', MSClickId: 'private-click' }] } : undefined);
    await expect(f.provider.offlineReports.daily(base)).rejects.toThrow('lacks aggregate counts');
  });
});

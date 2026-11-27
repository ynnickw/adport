import { describe, it, expect, vi } from 'vitest';
import { createContext } from '@adport/core';
import { AnalyticsClient, Ga4Provider } from '../src/index.js';

// Admin properties.keyEvents.list and Data properties.runReport, v1beta.
const id = 'properties/123/keyEvents/7';
const query = { provider: 'ga4', account_id: '123', start_date: '2026-11-01', end_date: '2026-11-07' };
async function fixture(...responses: unknown[]) {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'fixture' }));
  for (const data of responses) fetch.mockResolvedValueOnce(Response.json(data));
  const provider = new Ga4Provider(new AnalyticsClient({ clientId: 'fixture', clientSecret: 'fixture', refreshToken: 'fixture' }, fetch));
  const runtime = await createContext({ providerModules: [{ provider, tools: [] }] });
  return { fetch, call: (name: string, args: object) => runtime.registry.call(name, args, runtime.ctx) };
}
const values = (...v: string[]) => v.map(value => ({ value }));
const goals = { keyEvents: [{ name: id, eventName: 'order', countingMethod: 'ONCE_PER_SESSION' }] };
const baseRow = { dimensionValues: values('newsletter', 'email', 'winter', '/sale'), metricValues: values('42', '11', '123.45') };

describe('GA4 acquisition', () => {
  it('lists paged key event IDs and counting rules and rejects a repeated page', async () => {
    const args = { provider: 'ga4', account_id: '123' };
    const { call, fetch } = await fixture({ ...goals, nextPageToken: 'more' }, {});
    expect(await call('analytics_goals', args)).toMatchObject({ goals: [{ id, name: 'order', counting_method: 'ONCE_PER_SESSION' }] });
    expect(fetch.mock.calls[2]![0]).toContain('properties/123/keyEvents?pageSize=200&pageToken=more');
    const looping = await fixture({ nextPageToken: 'same' }, { nextPageToken: 'same' });
    await expect(looping.call('analytics_goals', args)).rejects.toThrow(/repeated/);
  });
  it('joins selected goal counts to the same UTM and landing tuple, retaining full sessions and purchase revenue', async () => {
    const { fetch, call } = await fixture(goals, { rows: [baseRow], rowCount: 3, metadata: { currencyCode: 'EUR', timeZone: 'Europe/Paris' } },
      { rows: [{ dimensionValues: values('newsletter', 'email', 'winter', '/sale', 'order'), metricValues: values('3') }], rowCount: 1 });
    const result = await call('analytics_acquisition_report', { ...query, goal_ids: [id], landing_page: true, limit: 1, cursor: '1' });
    expect(result).toMatchObject({ currency: 'EUR', date_range: { timezone: 'Europe/Paris' }, next_cursor: '2',
      rows: [{ dimensions: { source: 'newsletter', medium: 'email', campaign: 'winter', landing_page: '/sale' },
        metrics: { sessions: 42, conversions: 3, revenue: 123.45 }, goal_counts: { [id]: 3 } }] });
    const body = (n: number) => JSON.parse(fetch.mock.calls[n]![1].body);
    expect(body(2)).toMatchObject({ dateRanges: [{ startDate: query.start_date, endDate: query.end_date }], offset: '1', limit: '1',
      dimensions: ['sessionSource', 'sessionMedium', 'sessionCampaignName', 'landingPage'].map(name => ({ name })) });
    expect(body(2)).not.toHaveProperty('dimensionFilter');
    expect(body(3).metrics).toEqual([{ name: 'keyEvents' }]);
    expect(body(3).dimensionFilter.andGroup.expressions[0].filter.inListFilter.values).toEqual(['order']);
  });
  it('distinguishes missing/restricted counts and revenue from a reported zero', async () => {
    const { call } = await fixture(goals, { rows: [baseRow], metadata: { schemaRestrictionResponse: { activeMetricRestrictions: [{ metricName: 'purchaseRevenue' }] } } },
      { metadata: { subjectToThresholding: true } });
    expect(await call('analytics_acquisition_report', { ...query, goal_ids: [id], landing_page: true }))
      .toMatchObject({ rows: [{ metrics: { sessions: 42, conversions: null, revenue: null }, goal_counts: { [id]: null } }], notes: expect.arrayContaining([expect.stringContaining('thresholds')]) });
    const unt = await fixture({ rows: [{ dimensionValues: values('(not set)', '(none)', '(not set)'), metricValues: values('8', '0', '0') }] });
    expect(await unt.call('analytics_acquisition_report', query)).toMatchObject({ rows: [{ dimensions: { source: null, campaign: null }, metrics: { sessions: 8, conversions: 0, revenue: 0 } }] });
  });
  it('rejects a stale or foreign goal before requesting a report', async () => {
    const { call, fetch } = await fixture(goals);
    await expect(call('analytics_acquisition_report', { ...query, goal_ids: ['properties/999/keyEvents/7'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

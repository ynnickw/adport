import { expect, it, vi } from 'vitest';
import { createContext } from '@adport/core';
import { MatomoClient, MatomoProvider } from '../src/index.js';

const query = { provider: 'matomo', account_id: '1', start_date: '2026-11-01', end_date: '2026-11-03' };
const tagged = { nb_visits: 8, nb_conversions: 3, goals: { 'idgoal=4': { nb_conversions: 2, revenue: 10 }, 'idgoal=ecommerceOrder': { nb_conversions: 1, revenue: 75 } }, revenue: 85 };
const defaults: Record<string, unknown> = {
  'SitesManager.getSiteFromId': { idsite: 1, timezone: 'UTC', currency: 'EUR', ecommerce: 1 },
  'Goals.getGoals': [{ idsite: 1, idgoal: 4, name: 'Signup', allow_multiple: 0 }],
  'API.getReportMetadata': [{ module: 'MarketingCampaignsReporting', action: 'getSourceMedium' }],
  'MarketingCampaignsReporting.getSourceMedium': [{ label: 'search - cpc', ...tagged, subtable: [{ label: 'winter', ...tagged }] }],
  'MarketingCampaignsReporting.getSource': [{ label: 'search' }], 'MarketingCampaignsReporting.getMedium': [{ label: 'cpc' }],
  'MarketingCampaignsReporting.getName': [{ label: 'winter', ...tagged }, { label: 'untagged-name', nb_visits: 2 }],
  'Referrers.getReferrerType': [{ label: 'Campaigns', ...tagged, nb_visits: 10 }, { label: 'Direct Entry', nb_visits: 3 }],
};
async function fixture(extra: Record<string, unknown> = {}) {
  const values = { ...defaults, ...extra };
  const send = vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
    const name = init.body.get('method')!;
    if (!Object.hasOwn(values, name)) throw new Error('Unrecognised API method');
    return Response.json(values[name]);
  });
  const provider = new MatomoProvider(new MatomoClient({ url: 'https://analytics.example.test', tokenAuth: 'test' }, send));
  const rt = await createContext({ providerModules: [{ provider, tools: [] }] });
  return { send, call: (name: string, args: object) => rt.registry.call(name, args, rt.ctx) };
}
it('uses joint archive children, preserves untagged sessions and counts only the selected goals', async () => {
  const { call, send } = await fixture();
  expect(await call('analytics_goals', { provider: 'matomo', account_id: '1' })).toMatchObject({ goals: [
    { id: '4', name: 'Signup' }, { id: 'ecommerceOrder', name: 'Ecommerce orders' }] });
  expect(await call('analytics_acquisition_report', { ...query, goal_ids: ['4'], limit: 1 })).toMatchObject({ next_cursor: '0.1',
    rows: [{ dimensions: { source: 'search', medium: 'cpc', campaign: 'winter' }, metrics: { sessions: 8, conversions: 2, revenue: 75 }, goal_counts: { '4': 2 } }] });
  expect(send.mock.calls.find(([, i]) => i.body.get('method')?.endsWith('getSourceMedium'))?.[1].body.get('expanded')).toBe('1');
  expect(await call('analytics_acquisition_report', { ...query, cursor: '0.1' })).toMatchObject({
    rows: [{ dimensions: { source: null, campaign: 'untagged-name' }, metrics: { sessions: 2 } }, { dimensions: { campaign: null }, metrics: { sessions: 3 } }] });
});
it('refuses unknown goals and reports missing campaign dimensions explicitly on core-only sites', async () => {
  const { call } = await fixture({ 'API.getReportMetadata': [], 'Referrers.getCampaigns': [{ label: 'winter', ...tagged }] });
  await expect(call('analytics_acquisition_report', { ...query, goal_ids: ['999'] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(await call('analytics_acquisition_report', query)).toMatchObject({
    notes: [expect.stringContaining('source and medium are unavailable')], rows: expect.arrayContaining([expect.objectContaining({ dimensions: { source: null, medium: null, campaign: 'winter' } })]) });
});
it('groups entry URL variants together, strips query strings, and rejects incomplete segmented archives', async () => {
  const entries = [{ url: 'https://site.test/offer?a=1', entry_nb_visits: 7 }, { url: 'https://site.test/offer?a=2', entry_nb_visits: 6 },
    { url: 'https://site.test/other', entry_nb_visits: 1 }];
  const { call, send } = await fixture({ 'Actions.getEntryPageUrls': entries });
  expect(await call('analytics_acquisition_report', { ...query, landing_page: true })).toMatchObject({ next_cursor: '1.0',
    rows: expect.arrayContaining([expect.objectContaining({ dimensions: { source: 'search', medium: 'cpc', campaign: 'winter', landing_page: 'https://site.test/offer' } })]) });
  const segmented = send.mock.calls.filter(([, i]) => i.body.has('segment'));
  expect(segmented).toHaveLength(5);
  expect(segmented[0]![1].body.get('segment')).toBe('entryPageUrl==https%3A%2F%2Fsite.test%2Foffer%3Fa%3D1,entryPageUrl==https%3A%2F%2Fsite.test%2Foffer%3Fa%3D2');
  await expect(call('analytics_acquisition_report', { ...query, landing_page: true, cursor: '1.0' })).rejects.toThrow(/segmented archive/);
});

import { createContext, type WriteOperation } from '@adport/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MicrosoftAdsClient, formatPartialErrors } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// Verified against pinned MicrosoftDocs/Advertising REST v13 JSON definitions:
// AdGroups/Ads/Keywords query paths, PUT updates, TextAsset and AssetLink.
const parent = { account_id: '777', campaign_id: '10', ad_group_id: '20' }, guard = { forcePausedCreation: true };
function setup(override?: (path: string, body: Record<string, unknown>, method: string) => unknown) {
  const calls: Array<{ path: string; body: Record<string, unknown>; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'test-token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body, init });
    const defaults: Record<string, unknown> = {
      'User/Query': { User: { Id: '1' } }, 'Accounts/Search': { Accounts: [{ Id: '777', Name: 'Account', ParentCustomerId: '9001' }] },
      'Campaigns/QueryByAccountId': { Campaigns: [{ Id: '10', Name: 'Parent', Status: 'Paused' }] },
      'AdGroups/QueryByIds': { AdGroups: [{ Id: '20', Name: 'Group', AdGroupType: 'SearchStandard', Status: 'Paused', CpcBid: { Amount: 0.3 } }] },
      'AdGroups/QueryByCampaignId': { AdGroups: [{ Id: '20', AdGroupType: 'SearchStandard', Status: 'Paused' }] },
      'Ads/QueryByIds': { Ads: [{ Id: '30', Type: 'ResponsiveSearch', Status: 'Paused', Headlines: [{ Asset: { Id: '91', Type: 'TextAsset', Text: 'Original headline' }, PinnedField: 'Headline1' }], Descriptions: [{ Asset: { Text: 'Original description' } }] }] },
      'Ads/QueryByAdGroupId': { Ads: [{ Id: '30', Type: 'ResponsiveSearch', Status: 'Paused', Headlines: [{ Asset: { Type: 'TextAsset', Text: 'Actual headline' } }], Descriptions: [{ Asset: { Text: 'Actual description' } }], FinalUrls: ['https://example.com'] }] },
      'Keywords/QueryByIds': { Keywords: ((body.KeywordIds as string[] | undefined) ?? []).map(Id => ({ Id, Text: 'Original keyword', MatchType: 'Exact', Status: 'Paused', Bid: { Amount: 0.3 } })) },
      'Keywords/QueryByAdGroupId': { Keywords: [{ Id: '40', Text: 'Original keyword', MatchType: 'Exact', Status: 'Paused' }] },
      AdGroups: { AdGroupIds: ['21'], PartialErrors: [] }, Ads: { AdIds: ['31'], PartialErrors: [] }, Keywords: { KeywordIds: ['41'], PartialErrors: [] },
    };
    const result = override?.(path, body, init.method ?? 'POST') ?? defaults[path];
    if (result === undefined) throw new Error(`Unmatched Microsoft path ${path}`);
    return Response.json(result);
  });
  const provider = new MicrosoftAdsProvider(new MicrosoftAdsClient({ developerToken: 'test-dev', clientId: 'test-client', refreshToken: 'test-refresh' }, undefined, fetcher as typeof fetch));
  return { provider, calls };
}
const op = (tool: string, payload: Record<string, unknown>, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: '777', kind, payload: { campaign_id: '10', ad_group_id: '20', ...payload } });

describe('Microsoft child entity lifecycle', () => {
  it('reads the scoped hierarchy and renders real RSA content with bound actions', async () => {
    const { provider, calls } = setup();
    const result = await provider.children.listAds({ ...parent, ad_types: ['ResponsiveSearch'], limit: 50 });
    expect(result.creatives[0]).toMatchObject({ id: '30', account_id: '777', headlines: ['Actual headline'], descriptions: ['Actual description'], landing_urls: ['https://example.com'] });
    expect(result.creatives[0]?.actions[0]?.arguments).toEqual({ ...parent, ad_id: '30', ad_type: 'ResponsiveSearch' });
    expect(microsoftTools(provider).find(tool => tool.name === 'microsoft_ads')!.output!.safeParse(result).success).toBe(true);
    const read = calls.find(call => call.path === 'Ads/QueryByAdGroupId')!;
    expect(read.body).toEqual({ AdGroupId: '20', AdTypes: ['ResponsiveSearch'], ReturnAdditionalFields: null });
    expect(read.init.headers).toMatchObject({ CustomerId: '9001', CustomerAccountId: '777' });
    expect(calls.find(call => call.path === 'AdGroups/QueryByIds')!.body.ReturnAdditionalFields).toBe('AdGroupType');
  });

  it('creates a paused SearchStandard group only on apply and uses whole-unit bids', async () => {
    const { provider, calls } = setup();
    const operation = op('microsoft_create_ad_group', { name: 'QA group', language: 'English', cpc_bid: 0.35, status: 'Active' }, 'create');
    await expect(provider.previewWrite(operation, guard)).resolves.toMatchObject({ serverValidated: false, coercions: ['status coerced to Paused by policy (paused_creation)'] });
    expect(calls.some(call => call.path === 'AdGroups')).toBe(false);
    await expect(provider.applyWrite(operation, guard)).resolves.toMatchObject({ resourceIds: ['21'] });
    expect(calls.at(-1)!.body).toEqual({ CampaignId: '10', AdGroups: [{ Name: 'QA group', AdGroupType: 'SearchStandard', Language: 'English', Status: 'Paused', CpcBid: { Amount: 0.35 } }] });
  });

  it('creates a paused RSA with REST polymorphic TextAsset links', async () => {
    const { provider, calls } = setup();
    const operation = op('microsoft_create_responsive_search_ad', { headlines: ['First headline', 'Second headline', 'Third headline'], descriptions: ['First description', 'Second description'], final_urls: ['https://example.com'], status: 'Active', path1: 'ads' }, 'create');
    await provider.previewWrite(operation, guard); expect(calls.some(call => call.path === 'Ads')).toBe(false);
    await provider.applyWrite(operation, guard);
    expect(calls.at(-1)!.init.method).toBe('POST');
    expect(calls.at(-1)!.body).toEqual({ AdGroupId: '20', Ads: [{ Type: 'ResponsiveSearch', Status: 'Paused', Headlines: ['First headline', 'Second headline', 'Third headline'].map(Text => ({ Asset: { Type: 'TextAsset', Text } })), Descriptions: ['First description', 'Second description'].map(Text => ({ Asset: { Type: 'TextAsset', Text } })), FinalUrls: ['https://example.com'], Path1: 'ads' }] });
  });

  it('updates copy via PUT while preserving pinning and leaving omitted fields/status untouched', async () => {
    const { provider, calls } = setup();
    await provider.applyWrite(op('microsoft_update_responsive_search_ad', { ad_id: '30', headlines: ['New first', 'New second', 'New third'] }), guard);
    const update = calls.at(-1)!;
    expect(update.init.method).toBe('PUT');
    expect(update.body).toEqual({ AdGroupId: '20', Ads: [{ Id: '30', Type: 'ResponsiveSearch', Headlines: [
      { Asset: { Type: 'TextAsset', Text: 'New first' }, PinnedField: 'Headline1' }, { Asset: { Type: 'TextAsset', Text: 'New second' } }, { Asset: { Type: 'TextAsset', Text: 'New third' } },
    ] }] });
  });

  it.each(['microsoft_set_ad_group_status', 'microsoft_update_ad_group', 'microsoft_set_ad_status', 'microsoft_add_keywords', 'microsoft_remove_keywords'])('rejects a wrong parent for %s before mutation', async tool => {
    const { provider, calls } = setup(path => path === 'AdGroups/QueryByIds' ? { AdGroups: [null] } : undefined);
    await expect(provider.applyWrite(op(tool, { status: 'Active', name: 'No', ad_id: '30', ad_type: 'ResponsiveSearch', keywords: [{ text: 'No', match_type: 'Exact' }], keyword_ids: ['40'] }), guard)).rejects.toThrow('selected campaign/account');
    expect(calls.some(call => ['AdGroups', 'Ads', 'Keywords'].includes(call.path))).toBe(false);
  });

  it('rejects a foreign ad ID and missing keyword IDs before a PUT/DELETE', async () => {
    const { provider, calls } = setup(path => path === 'Ads/QueryByIds' ? { Ads: [null] } : path === 'Keywords/QueryByIds' ? { Keywords: [null] } : undefined);
    await expect(provider.applyWrite(op('microsoft_set_ad_status', { ad_id: '30', ad_type: 'ResponsiveSearch', status: 'Active' }), guard)).rejects.toThrow('selected ad group/account');
    await expect(provider.applyWrite(op('microsoft_remove_keywords', { keyword_ids: ['40'] }, 'remove'), guard)).rejects.toThrow('selected ad group/account');
    expect(calls.every(call => call.init.method === 'POST')).toBe(true);
  });

  it('creates keywords paused and updates only the requested keyword bid/status fields', async () => {
    const { provider, calls } = setup();
    const preview = await provider.previewWrite(op('microsoft_add_keywords', { keywords: [{ text: 'ad management', match_type: 'Exact', bid: 0.4, status: 'Active' }] }, 'create'), guard);
    expect(preview.coercions).toHaveLength(1);
    await provider.applyWrite(op('microsoft_add_keywords', { keywords: [{ text: 'ad management', match_type: 'Exact', bid: 0.4, status: 'Active' }] }, 'create'), guard);
    expect(calls.at(-1)!.body).toEqual({ AdGroupId: '20', Keywords: [{ Text: 'ad management', MatchType: 'Exact', Status: 'Paused', Bid: { Amount: 0.4 } }] });
    await provider.applyWrite(op('microsoft_set_keyword_bid', { keyword_id: '40', bid: 0.5 }), guard);
    expect(calls.at(-1)!.body).toEqual({ AdGroupId: '20', Keywords: [{ Id: '40', Bid: { Amount: 0.5 } }] });
    await provider.applyWrite(op('microsoft_set_keyword_status', { keyword_id: '40', status: 'Active' }), guard);
    expect(calls.at(-1)!.body).toEqual({ AdGroupId: '20', Keywords: [{ Id: '40', Status: 'Active' }] });
    await provider.applyWrite(op('microsoft_remove_keywords', { keyword_ids: ['40'] }, 'remove'), guard);
    expect(calls.at(-1)!.init.method).toBe('DELETE'); expect(calls.at(-1)!.body).toEqual({ AdGroupId: '20', KeywordIds: ['40'] });
  });

  it('retains successful IDs when a batch partially applies and rejects missing creation receipts', async () => {
    expect(formatPartialErrors([null])).toBeUndefined();
    const { provider } = setup(path => path === 'Keywords' ? { KeywordIds: ['41', null], PartialErrors: [null, { Index: 1, Code: 123, Message: 'Rejected' }] } : undefined);
    await expect(provider.applyWrite(op('microsoft_add_keywords', { keywords: [{ text: 'one', match_type: 'Exact' }, { text: 'two', match_type: 'Exact' }] }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['41'] } });
    const missing = setup(path => path === 'Ads' ? {} : undefined);
    await expect(missing.provider.applyWrite(op('microsoft_create_responsive_search_ad', { headlines: ['One', 'Two', 'Three'], descriptions: ['First', 'Second'], final_urls: ['https://example.com'] }, 'create'), guard)).rejects.toThrow('Check creation status before retrying');
  });

  it('exposes the new child writes through the shared two-step registry gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adport-ms-children-')), previous = process.env.ADPORT_HOME; process.env.ADPORT_HOME = directory;
    try {
      const { provider, calls } = setup(), runtime = await createContext({ providerModules: [{ provider, tools: microsoftTools(provider) }] });
      const args = { ...parent, ad_id: '30', ad_type: 'ResponsiveSearch', status: 'Paused' };
      const preview = await runtime.registry.call('microsoft_set_ad_status', args, runtime.ctx) as { pending_operation_id: string };
      expect(calls.every(call => call.init.method === 'POST')).toBe(true);
      await expect(runtime.registry.call('microsoft_set_ad_status', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).resolves.toMatchObject({ applied: true });
      expect(calls.at(-1)!.init.method).toBe('PUT');
    } finally { if (previous === undefined) delete process.env.ADPORT_HOME; else process.env.ADPORT_HOME = previous; await rm(directory, { recursive: true, force: true }); }
  });
});

import { createContext } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Wire format checked against Google's v25 resource/service protos and real
// customer/campaign/ad-group asset read receipts on2026-11-03.
const A = '1234567890', asset = '42';
type Body = Record<string, unknown>;
function fixture(scope: 'CUSTOMER' | 'CAMPAIGN' | 'AD_GROUP', exists = false, foreign = false) {
  const config = { CUSTOMER: ['customer_asset', 'customerAsset', 'customerAssets', '', 'BUSINESS_LOGO', 'IMAGE'], CAMPAIGN: ['campaign_asset', 'campaignAsset', 'campaignAssets', 'campaign', 'CALLOUT', 'CALLOUT'], AD_GROUP: ['ad_group_asset', 'adGroupAsset', 'adGroupAssets', 'ad_group', 'SITELINK', 'SITELINK'] }[scope]!;
  const [resource, key, service, parent, field, type] = config as [string, string, string, string, string, string];
  const parentId = scope === 'CUSTOMER' ? undefined : '11', link = `customers/${A}/${service}/${parentId ? `${parentId}~` : ''}${asset}~${field}`;
  const calls: { url: string; body: Body }[] = [];
  const client = new GoogleAdsRestClient({ clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh' }, 'v25', async (input, init = {}) => {
    const url = String(input), body = url.includes('oauth2.googleapis.com') ? {} : JSON.parse(String(init.body)); calls.push({ url, body });
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'token', expires_in: 3600 });
    if (url.endsWith('googleAds:search')) {
      const query = String(body.query);
      if (/FROM asset WHERE/.test(query)) return Response.json({ results: [{ asset: { id: asset, resourceName: `customers/${A}/assets/${asset}`, type } }] });
      if (parent && query.includes(`FROM ${parent} WHERE`)) return Response.json({ results: [{ [parent === 'ad_group' ? 'adGroup' : parent]: { id: parentId, resourceName: `customers/${foreign ? '9999999999' : A}/${scope === 'AD_GROUP' ? 'adGroups' : 'campaigns'}/${parentId}`, status: 'PAUSED' } }] });
      if (query.includes(`FROM ${resource} WHERE`)) return Response.json({ results: exists ? [{ [key]: { resourceName: link, asset: `customers/${A}/assets/${asset}`, fieldType: field, status: 'ENABLED' } }] : [] });
      throw new Error('Unexpected native query');
    }
    return Response.json({ results: [{ resourceName: link }] });
  });
  return { provider: new GoogleAdsProvider(client), calls, link, service, args: { account_id: A, scope, ...(parentId ? { parent_id: parentId } : {}), asset_id: asset, field_type: field } };
}

describe('Google shared asset associations', () => {
  it.each(['CUSTOMER', 'CAMPAIGN', 'AD_GROUP'] as const)('creates a native paused association for %s with reported coercion', async scope => {
    const f = fixture(scope);
    const op = { tool: 'google_link_asset', provider: 'google', accountId: A, kind: 'create' as const, payload: { ...f.args, status: 'ENABLED' } };
    const preview = await f.provider.previewWrite(op, { forcePausedCreation: true });
    expect(preview).toMatchObject({ serverValidated: true, budgetDeltas: [], coercions: ['asset-link status coerced to PAUSED by policy (paused_creation)'] });
    const request = f.calls.find(call => call.url.endsWith(`${f.service}:mutate`))!;
    const create = { asset: `customers/${A}/assets/${asset}`, fieldType: f.args.field_type, status: 'PAUSED', ...(scope === 'CAMPAIGN' ? { campaign: `customers/${A}/campaigns/11` } : scope === 'AD_GROUP' ? { adGroup: `customers/${A}/adGroups/11` } : {}) };
    expect(request.body).toEqual({ operations: [{ create }], partialFailure: false, validateOnly: true });
    expect(await f.provider.applyWrite(op, { forcePausedCreation: true })).toEqual({ applied: true, resourceIds: [f.link] });
    expect(f.calls.filter(call => call.url.endsWith(`${f.service}:mutate`))).toHaveLength(2);
  });

  it.each(['CUSTOMER', 'CAMPAIGN', 'AD_GROUP'] as const)('updates only native association status and removes only the exact link for %s', async scope => {
    const f = fixture(scope, true);
    await f.provider.previewWrite({ tool: 'google_set_asset_link_status', provider: 'google', accountId: A, kind: 'update', payload: { ...f.args, status: 'PAUSED' } }, { forcePausedCreation: true });
    expect(f.calls.at(-1)!.body).toEqual({ operations: [{ update: { resourceName: f.link, status: 'PAUSED' }, updateMask: 'status' }], partialFailure: false, validateOnly: true });
    await f.provider.previewWrite({ tool: 'google_unlink_asset', provider: 'google', accountId: A, kind: 'remove', payload: f.args }, { forcePausedCreation: true });
    expect(f.calls.at(-1)!.body).toEqual({ operations: [{ remove: f.link }], partialFailure: false, validateOnly: true });
    expect(f.calls.some(call => /\/assets:mutate$/.test(call.url))).toBe(false);
  });

  it('fails closed for a foreign parent, existing duplicate or missing association', async () => {
    const foreign = fixture('CAMPAIGN', false, true);
    await expect(foreign.provider.previewWrite({ tool: 'google_link_asset', provider: 'google', accountId: A, kind: 'create', payload: foreign.args }, { forcePausedCreation: true })).rejects.toThrow('parent');
    expect(foreign.calls.some(call => call.url.endsWith(':mutate'))).toBe(false);
    const duplicate = fixture('CAMPAIGN', true);
    await expect(duplicate.provider.previewWrite({ tool: 'google_link_asset', provider: 'google', accountId: A, kind: 'create', payload: duplicate.args }, { forcePausedCreation: true })).rejects.toThrow('already exists');
    const absent = fixture('CUSTOMER');
    await expect(absent.provider.previewWrite({ tool: 'google_unlink_asset', provider: 'google', accountId: A, kind: 'remove', payload: absent.args }, { forcePausedCreation: true })).rejects.toThrow('not found');
    expect(absent.calls.some(call => call.url.endsWith(':mutate'))).toBe(false);
  });

  it('retains parent refinements and requires an explicit status at the registry boundary', async () => {
    const f = fixture('CAMPAIGN');
    const rt = await createContext({ providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    await expect(rt.registry.call('google_link_asset', { ...f.args, parent_id: undefined }, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(rt.registry.call('google_link_asset', { ...f.args, scope: 'CUSTOMER', parent_id: '11' }, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(rt.registry.call('google_set_asset_link_status', f.args, rt.ctx)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toEqual([]);
  });

  it('reads only the selected parent and returns raw native association states', async () => {
    const f = fixture('AD_GROUP', true);
    expect(await f.provider.assetLinks.list({ account_id: A, scope: 'AD_GROUP', parent_id: '11', limit: 1 })).toEqual({ links: [{ resourceName: f.link, asset: `customers/${A}/assets/${asset}`, fieldType: 'SITELINK', status: 'ENABLED' }], truncated: false });
    expect(f.calls.at(-1)!.body.query).toContain(`ad_group_asset.ad_group = 'customers/${A}/adGroups/11'`);
    expect(f.calls.at(-1)!.body.query).toContain("ad_group_asset.status != 'REMOVED'");
  });
});

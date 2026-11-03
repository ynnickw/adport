import { describe, expect, it } from 'vitest';
import type { WriteOperation } from '@adport/core';
import { MicrosoftAdsClient } from '../src/client.js';
import { MicrosoftAdsProvider } from '../src/provider.js';
import { microsoftTools } from '../src/tools.js';

// REST JSON contracts: MicrosoftDocs/Advertising@fdee2fcf. Native CSV flags use SDK@4b6fb31c.
type Row = Record<string, unknown>;
const account = '777', guard = { forcePausedCreation: true };
const schedule = { StartDate: { Year: 2027, Month: 1, Day: 1 }, UseSearcherTimeZone: true };
const extension = (Id = '42', Type = 'SitelinkAdExtension'): Row => ({ Id, Type, Version: 3, Status: 'Active', Scheduling: schedule, DevicePreference: '30001', ForwardCompatibilityMap: null,
  ...(Type === 'SitelinkAdExtension' ? { DisplayText: 'Account library', Description1: 'First description', Description2: 'Second description', FinalUrls: ['https://adport.dev/'], FinalMobileUrls: ['https://adport.dev/mobile'], TrackingUrlTemplate: 'https://adport.dev/?u={lpurl}', FinalUrlSuffix: 'source=qa', UrlCustomParameters: { Parameters: [{ Key: 'source', Value: 'qa' }] } } : Type === 'CalloutAdExtension' ? { Text: 'Owned QA callout' } : Type === 'ImageAdExtension' ? { AlternativeText: 'QA alternative text', Description: 'Owned QA image extension', ImageMediaIds: ['100'], Images: [{ Asset: { Id: '100', Type: 'ImageAsset', SubType: 'OriginalImage', CropWidth: 640, CropHeight: 640 }, EditorialStatus: 'Active', AssetPerformanceLabel: 'Good' }], Layouts: ['SearchSingle'] } : { Header: 'Services', Values: ['One', 'Two', 'Three'] }) });
function fixture(override?: (path: string, body: Row, method: string) => unknown) {
  const calls: Array<{ path: string; body: Row; init: RequestInit }> = [];
  const state = { extensions: [extension()], linked: false, campaignStatus: 'Paused', groupStatus: 'Active' };
  const client = new MicrosoftAdsClient({ developerToken: 'dev', clientId: 'client', refreshToken: 'refresh' }, undefined, async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'token', expires_in: 3600 });
    const path = url.pathname.replace(/^.*\/v13\//, ''), body = JSON.parse(String(init.body ?? '{}')) as Row, method = init.method ?? 'POST';
    calls.push({ path, body, init });
    const custom = override?.(path, body, method);
    if (custom !== undefined) return custom instanceof Response ? custom : Response.json(custom);
    if (path === 'User/Query') return Response.json({ User: { Id: '1' } });
    if (path === 'Accounts/Search') return Response.json({ Accounts: [{ Id: account, ParentCustomerId: '9001' }] });
    if (path === 'Campaigns/QueryByAccountId') return Response.json({ Campaigns: [{ Id: '9', Name: 'Own paused campaign', Status: state.campaignStatus }] });
    if (path === 'AdGroups/QueryByIds') return Response.json({ AdGroups: [{ Id: '10', Status: state.groupStatus }] });
    if (path === 'AdExtensionIds/QueryByAccountId') return Response.json({ AdExtensionIds: state.extensions.filter(value => String(body.AdExtensionType).includes(String(value.Type))).map(value => value.Id) });
    if (path === 'AdExtensions/QueryByIds') return Response.json({ AdExtensions: (body.AdExtensionIds as string[]).map(id => state.extensions.find(value => value.Id === id && String(body.AdExtensionType).includes(String(value.Type))) ?? null), PartialErrors: [] });
    if (path === 'MediaMetaData/QueryByAccountId') return Response.json({ MediaMetaData: ['100', '101'].map(Id => ({ Id, MediaType: 'GenericImage', Representations: [{ Url: 'https://www.bing.com/th?id=qa-image' }] })) });
    if (path === 'AdExtensions' && method === 'POST') {
      const item = (body.AdExtensions as Row[])[0]!;
      state.extensions.push({ ...item, Id: '43', Status: 'Active', Version: 1 });
      return Response.json({ AdExtensionIdentities: [{ Id: '43', Version: 1 }], NestedPartialErrors: [] });
    }
    if (path === 'AdExtensions' && method === 'PUT') {
      const item = (body.AdExtensions as Row[])[0]!, current = state.extensions.find(value => value.Id === item.Id)!;
      state.extensions = state.extensions.map(value => value.Id === item.Id ? { ...item, Version: Number(current.Version) + 1, Status: 'Active' } : value);
      return Response.json({ NestedPartialErrors: [] });
    }
    if (path === 'AdExtensions' && method === 'DELETE') { state.extensions = state.extensions.filter(value => !(body.AdExtensionIds as string[]).includes(String(value.Id))); return Response.json({ PartialErrors: [] }); }
    if (path === 'AdExtensionsAssociations/Set') { state.linked = true; return Response.json({ PartialErrors: [] }); }
    if (path === 'AdExtensionsAssociations' && method === 'DELETE') { state.linked = false; return Response.json({ PartialErrors: [] }); }
    if (path === 'AdExtensionsAssociations/Query') return Response.json({ AdExtensionAssociationCollection: [{ AdExtensionAssociations: state.linked ? [{ AdExtension: state.extensions[0], EntityId: (body.EntityIds as string[])[0], AssociationType: body.AssociationType, EditorialStatus: 'Active' }] : [] }], PartialErrors: [] });
    throw new Error(`Unexpected path ${path}`);
  });
  return { provider: new MicrosoftAdsProvider(client), state, calls };
}
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ tool, provider: 'microsoft', accountId: account, payload, kind });
const reference = { extension_id: '42', extension_type: 'SitelinkAdExtension', expected_version: 3 };

describe('Microsoft shared ad extensions', () => {
  it('defines tools lazily and validates subtype-specific content through the shared schemas', () => {
    const tools = microsoftTools(new Proxy({} as MicrosoftAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    const update = tools.find(value => value.name === 'microsoft_update_ad_extension')!;
    expect(update.input.safeParse({ account_id: account, ...reference, display_text: 'New copy' }).success).toBe(true);
    expect(update.input.safeParse({ account_id: account, ...reference, text: 'Wrong subtype' }).success).toBe(false);
    expect(update.input.safeParse({ account_id: account, ...reference }).success).toBe(false);
  });

  it('pages account-owned extension IDs using REST CSV flags and retains native versions in edit actions', async () => {
    const f = fixture(); f.state.extensions.push(extension('43', 'CalloutAdExtension'));
    const input = { account_id: account, extension_types: ['SitelinkAdExtension', 'CalloutAdExtension'] as Array<'SitelinkAdExtension' | 'CalloutAdExtension'>, limit: 1 };
    const first = await f.provider.extensions.list(input);
    expect(first).toMatchObject({ truncated: true, next_cursor: '42', creatives: [{ id: '42', status: 'Active', actions: [{ arguments: { account_id: account, expected_version: 3 } }] }] });
    expect(f.calls.find(value => value.path === 'AdExtensionIds/QueryByAccountId')!.body).toEqual({ AccountId: account, AdExtensionType: 'SitelinkAdExtension, CalloutAdExtension', AssociationType: null });
    expect(await f.provider.extensions.list({ ...input, after_extension_id: '42' })).toMatchObject({ truncated: false, creatives: [{ id: '43' }] });
    expect(f.calls.at(-1)!.init.headers).toMatchObject({ CustomerAccountId: account, CustomerId: '9001' });
  });

  it('hydrates image-extension previews only from account-owned source media', async () => {
    const f = fixture(); f.state.extensions = [extension('42', 'ImageAdExtension')];
    expect(await f.provider.extensions.get({ account_id: account, extension_id: '42', extension_type: 'ImageAdExtension' })).toMatchObject({ creatives: [{ media: [{ url: 'https://www.bing.com/th?id=qa-image', alt: 'QA alternative text' }], actions: [{ fields: [{ key: 'alternative_text' }, { key: 'description' }, { key: 'image_ids', value: ['100'] }] }] }] });
  });

  it('creates unattached extensions without writing during preview, then verifies native identity and content', async () => {
    const f = fixture(), operation = op('microsoft_create_ad_extension', { content: { extension_type: 'CalloutAdExtension', text: 'Unattached QA callout' } }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: false, budgetDeltas: [] });
    expect(f.calls).toEqual([]);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['43'] });
    expect(f.calls.find(value => value.path === 'AdExtensions')!.body).toEqual({ AccountId: account, AdExtensions: [{ Type: 'CalloutAdExtension', Text: 'Unattached QA callout' }] });
    expect(f.calls.some(value => value.path.startsWith('AdExtensionsAssociations'))).toBe(false);
  });

  it('preserves all omitted mutable sitelink fields and omits native read-only Version during PUT', async () => {
    const f = fixture(), before = f.state.extensions[0]!, operation = op('microsoft_update_ad_extension', { ...reference, display_text: 'Updated QA' });
    await f.provider.previewWrite(operation, guard);
    expect(f.calls.some(value => value.init.method === 'PUT')).toBe(false);
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['42'] });
    const sent = (f.calls.find(value => value.init.method === 'PUT')!.body.AdExtensions as Row[])[0]!;
    expect(sent).toEqual({ Id: '42', Type: 'SitelinkAdExtension', DisplayText: 'Updated QA', Description1: before.Description1, Description2: before.Description2, FinalUrls: before.FinalUrls, FinalMobileUrls: before.FinalMobileUrls, DevicePreference: '30001', Scheduling: schedule, TrackingUrlTemplate: before.TrackingUrlTemplate, FinalUrlSuffix: before.FinalUrlSuffix, UrlCustomParameters: before.UrlCustomParameters });
    expect(sent).not.toHaveProperty('Version'); expect(sent).not.toHaveProperty('Status');
  });

  it('refuses stale approvals and unsupported non-null fields before any mutation', async () => {
    const stale = fixture();
    await expect(stale.provider.previewWrite(op('microsoft_update_ad_extension', { ...reference, expected_version: 2, display_text: 'New' }), guard)).rejects.toThrow('version changed');
    const unknown = fixture(); unknown.state.extensions[0]!.FutureTrackingSetting = 'must not lose';
    await expect(unknown.provider.previewWrite(op('microsoft_update_ad_extension', { ...reference, display_text: 'New' }), guard)).rejects.toThrow('safe full replacement');
    expect(unknown.calls.some(value => value.init.method === 'PUT')).toBe(false);
  });

  it('preserves source crops while editing extension alternative text, and verifies replacement image ownership', async () => {
    const f = fixture(); f.state.extensions = [extension('42', 'ImageAdExtension')];
    const imageReference = { ...reference, extension_type: 'ImageAdExtension' };
    await f.provider.applyWrite(op('microsoft_update_ad_extension', { ...imageReference, alternative_text: 'Changed extension alt text', image_ids: ['100'] }), guard);
    const sent = (f.calls.find(value => value.init.method === 'PUT')!.body.AdExtensions as Row[])[0]!;
    expect(sent.Images).toEqual([{ Asset: { Id: '100', Type: 'ImageAsset', SubType: 'OriginalImage', CropWidth: 640, CropHeight: 640 } }]);
    expect(sent).toMatchObject({ AlternativeText: 'Changed extension alt text', ImageMediaIds: ['100'], Layouts: ['SearchSingle'] });
    await expect(f.provider.previewWrite(op('microsoft_update_ad_extension', { ...imageReference, expected_version: 4, image_ids: ['999'] }), guard)).rejects.toThrow('image references could not be verified');
  });

  it('validates paired sitelink descriptions against merged current content', async () => {
    const f = fixture();
    await expect(f.provider.previewWrite(op('microsoft_update_ad_extension', { ...reference, description1: '' }), guard)).rejects.toThrow('descriptions must be supplied together');
    await expect(f.provider.previewWrite(op('microsoft_update_ad_extension', { ...reference, display_text: 'x'.repeat(26) }), guard)).rejects.toThrow('25-character');
  });

  it('does not mistake HTTP success or a nested partial error for a verified content change', async () => {
    const noChange = fixture((path, _body, method) => path === 'AdExtensions' && method === 'PUT' ? { NestedPartialErrors: [] } : undefined);
    await expect(noChange.provider.applyWrite(op('microsoft_update_ad_extension', { ...reference, display_text: 'Changed QA' }), guard)).rejects.toMatchObject({ details: { resourceIds: ['42'] } });
    const partial = fixture((path, _body, method) => path === 'AdExtensions' && method === 'POST' ? { AdExtensionIdentities: [{ Id: '43', Version: 1 }], NestedPartialErrors: [{ Index: 0, BatchErrors: [{ Code: 123, Message: 'Native nested error' }] }] } : undefined);
    await expect(partial.provider.applyWrite(op('microsoft_create_ad_extension', { content: { extension_type: 'CalloutAdExtension', text: 'QA' } }, 'create'), guard)).rejects.toMatchObject({ details: { resourceIds: ['43'] } });
    expect(partial.calls.filter(value => value.path === 'AdExtensions')).toHaveLength(1);
  });

  it('requires a paused effective parent for new associations under paused_creation, with no fake association status', async () => {
    for (const target of [{ type: 'Account' }, { type: 'Campaign', campaign_id: '9' }]) {
      const f = fixture(); f.state.campaignStatus = 'Active';
      await expect(f.provider.previewWrite(op('microsoft_link_ad_extension', { ...reference, target }, 'create'), guard)).rejects.toThrow('cannot be paused');
      expect(f.calls.some(value => value.path === 'AdExtensionsAssociations/Set')).toBe(false);
    }
    const f = fixture(), operation = op('microsoft_link_ad_extension', { ...reference, target: { type: 'AdGroup', campaign_id: '9', ad_group_id: '10' } }, 'create');
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: ['42'] });
    expect(f.calls.find(value => value.path === 'AdExtensionsAssociations/Set')!.body).toEqual({ AccountId: account, AdExtensionIdToEntityIdAssociations: [{ AdExtensionId: '42', EntityId: '10' }], AssociationType: 'AdGroup' });
    expect(f.calls.some(value => ['Campaigns', 'AdGroups'].includes(value.path))).toBe(false);
  });

  it('compacts repeated editorial-country errors while preserving native codes and every affected country', async () => {
    const f = fixture(path => path === 'AdExtensions' ? { AdExtensionIdentities: [null], NestedPartialErrors: ['DE', 'US'].map(PublisherCountry => ({ Code: 1397, ErrorCode: 'CampaignServiceEditorialGenericError', Message: 'Editorial check failed', PublisherCountry, DisapprovedText: 'qa', Index: 0 })) } : undefined);
    await expect(f.provider.applyWrite(op('microsoft_create_ad_extension', { content: { extension_type: 'CalloutAdExtension', text: 'QA' } }, 'create'), guard)).rejects.toMatchObject({ message: expect.stringContaining('1397'), details: { resourceIds: [], nativeErrorCount: 2, errors: [{ Code: 1397, PublisherCountries: ['DE', 'US'] }] } });
  });

  it('verifies explicit association removal without deleting shared source content', async () => {
    const f = fixture(); f.state.linked = true;
    await f.provider.applyWrite(op('microsoft_unlink_ad_extension', { ...reference, target: { type: 'Campaign', campaign_id: '9' } }, 'remove'), guard);
    expect(f.calls.find(value => value.init.method === 'DELETE')!.path).toBe('AdExtensionsAssociations');
    expect(f.state.extensions).toHaveLength(1); expect(f.state.linked).toBe(false);
  });

  it('confirms native deletion through account inventory and retains the source image', async () => {
    const f = fixture();
    expect(await f.provider.applyWrite(op('microsoft_delete_ad_extension', reference, 'remove'), guard)).toEqual({ applied: true, resourceIds: ['42'] });
    expect(f.calls.find(value => value.init.method === 'DELETE')!.body).toEqual({ AccountId: account, AdExtensionIds: ['42'] });
    expect(f.calls.some(value => value.path === 'Media')).toBe(false);
  });
});

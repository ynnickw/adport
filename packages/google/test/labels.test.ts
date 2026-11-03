import { createContext, DEFAULT_POLICY, PolicyEngine, type PendingOperation, type WriteOperation } from '@adport/core';
import { describe, expect, it } from 'vitest';
import { GoogleAdsRestClient } from '../src/client.js';
import { GoogleAdsProvider } from '../src/provider.js';
import { googleTools } from '../src/tools.js';

// Google Ads v25 service/resource protos, googleapis/googleapis@57aa4dbc.
// CustomerLabel has a different output-only wire shape and is deliberately separate.
type Row = Record<string, unknown>;
const account = '1234567890', labelId = '9007199254740993', resource = `customers/${account}/labels/${labelId}`;
const guard = { forcePausedCreation: true };
const op = (tool: string, payload: Row, kind: WriteOperation['kind'] = 'update'): WriteOperation => ({ provider: 'google', tool, accountId: account, payload, kind });
function fixture() {
  const label: Row = { id: labelId, resourceName: resource, status: 'ENABLED', name: 'Shared label', textLabel: { backgroundColor: '#123456', description: 'Preserved description' } };
  const state = { label, labels: undefined as Row[] | undefined, links: [] as Row[], foreign: false, wrongParent: false, badReceipt: false };
  const calls: { url: string; body: Row }[] = [];
  const provider = new GoogleAdsProvider(new GoogleAdsRestClient({ clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh' }, 'v25', async (input, init = {}) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-token', expires_in: 3600 });
    const body = JSON.parse(String(init.body)) as Row; calls.push({ url, body });
    if (url.endsWith('googleAds:search')) {
      const query = String(body.query);
      if (query.includes(' FROM label ')) return Response.json({ results: (state.labels ?? [state.label]).map(label => ({ label: state.foreign ? { ...label, resourceName: 'customers/9999999999/labels/42' } : label })) });
      if (/ FROM (campaign|ad_group|ad_group_ad|ad_group_criterion)_label /.test(query)) return Response.json({ results: state.links });
      const entity = query.match(/ FROM (\w+) /)![1]!, config = { campaign: ['campaign', 'campaigns/11'], ad_group: ['adGroup', 'adGroups/22'], ad_group_ad: ['adGroupAd', 'adGroupAds/22~33'], ad_group_criterion: ['adGroupCriterion', 'adGroupCriteria/22~44'] }[entity]!;
      return Response.json({ results: [{ campaign: { id: state.wrongParent ? '99' : '11' }, adGroup: { id: '22' }, [config[0]!]: { ...(entity === 'campaign' ? { id: '11' } : entity === 'ad_group' ? { id: '22' } : {}), resourceName: `customers/${state.foreign ? '9999999999' : account}/${config[1]}`, status: 'ENABLED' } }] });
    }
    const operation = (body.operations as Row[])[0]!, collection = url.match(/\/([A-Za-z]+):mutate$/)![1]!;
    const expected = operation.remove ?? (operation.update as Row | undefined)?.resourceName ?? (collection === 'labels' ? resource : `customers/${account}/${collection}/${collection === 'campaignLabels' ? '11' : collection === 'adGroupLabels' ? '22' : collection === 'adGroupAdLabels' ? '22~33' : '22~44'}~${labelId}`);
    return Response.json(body.validateOnly ? {} : { results: [{ resourceName: state.badReceipt ? `customers/9999999999/labels/42` : expected }] });
  }));
  return { provider, calls, state };
}
const writes = (f: ReturnType<typeof fixture>) => f.calls.filter(value => value.url.endsWith(':mutate'));
const targetCases = [
  [{ type: 'CAMPAIGN', campaign_id: '11' }, 'campaignLabel', 'campaignLabels', 'campaign', 'campaigns/11', '11'],
  [{ type: 'AD_GROUP', campaign_id: '11', ad_group_id: '22' }, 'adGroupLabel', 'adGroupLabels', 'adGroup', 'adGroups/22', '22'],
  [{ type: 'AD_GROUP_AD', campaign_id: '11', ad_group_id: '22', ad_id: '33' }, 'adGroupAdLabel', 'adGroupAdLabels', 'adGroupAd', 'adGroupAds/22~33', '22~33'],
  [{ type: 'AD_GROUP_CRITERION', campaign_id: '11', ad_group_id: '22', criterion_id: '44' }, 'adGroupCriterionLabel', 'adGroupCriterionLabels', 'adGroupCriterion', 'adGroupCriteria/22~44', '22~44'],
] as const;

describe('Google owned label metadata and assignments', () => {
  it('constructs tools lazily and rejects unsupported customer-label and invalid metadata inputs', () => {
    const tools = googleTools(new Proxy({} as GoogleAdsProvider, { get() { throw new Error('Eager provider access'); } }));
    expect(tools.filter(value => /label/.test(value.name))).toHaveLength(8);
    const create = tools.find(value => value.name === 'google_create_label')!.input;
    for (const input of [{ name: '' }, { name: ' ' }, { name: 'a'.repeat(81) }, { name: 'Valid', background_color: 'red' }, { name: 'Valid', description: 'a'.repeat(201) }]) expect(create.safeParse({ account_id: account, ...input }).success).toBe(false);
    const update = tools.find(value => value.name === 'google_update_label')!.input;
    expect(update.safeParse({ account_id: account, label_id: labelId, expected_label_hash: 'a'.repeat(64) }).success).toBe(false);
    expect(tools.find(value => value.name === 'google_link_label')!.input.safeParse({ account_id: account, label_id: labelId, expected_label_hash: 'a'.repeat(64), target: { type: 'CUSTOMER', customer_id: account } }).success).toBe(false);
  });

  it('reads labels with lossless ordered int64 continuation and stable normalized metadata hashes', async () => {
    const f = fixture(), second = '9007199254740994'; f.state.labels = [f.state.label, { ...f.state.label, id: second, resourceName: `customers/${account}/labels/${second}` }];
    expect(await f.provider.labels.list({ account_id: account, limit: 1 })).toMatchObject({ labels: [{ id: labelId }], truncated: true, next_cursor: labelId });
    f.state.labels = [f.state.labels[1]!];
    expect(await f.provider.labels.list({ account_id: account, after_label_id: labelId, limit: 1 })).toMatchObject({ labels: [{ id: second }], truncated: false });
    expect(f.calls.at(-1)!.body.query).toContain(`label.id > ${labelId} ORDER BY label.id ASC LIMIT 2`);
    f.state.labels = undefined;
    const a = await f.provider.labels.get(account, labelId); f.state.label = { textLabel: { description: 'Preserved description', backgroundColor: '#123456' }, name: 'Shared label', status: 'ENABLED', resourceName: resource, id: labelId };
    expect((await f.provider.labels.get(account, labelId)).snapshot_hash).toBe(a.snapshot_hash);
    expect(writes(f)).toEqual([]);
  });

  it('rejects foreign labels, removed labels, missing exact identities and unordered pagination', async () => {
    const f = fixture(); f.state.foreign = true;
    await expect(f.provider.labels.get(account, labelId)).rejects.toThrow('invalid identity');
    f.state.foreign = false; f.state.label.status = 'REMOVED';
    await expect(f.provider.labels.get(account, labelId)).rejects.toThrow('invalid identity');
    f.state.label.status = 'ENABLED';
    await expect(f.provider.labels.get(account, '42')).rejects.toThrow('identity mismatch');
    await expect(f.provider.labels.list({ account_id: account, after_label_id: labelId, limit: 2 })).rejects.toThrow('did not advance');
    expect(writes(f)).toEqual([]);
  });

  it('creates unattached metadata without fake pause fields and uses native validation before any apply', async () => {
    const f = fixture(), operation = op('google_create_label', { name: 'New label', background_color: '#abc', description: 'Description' }, 'create');
    expect(await f.provider.previewWrite(operation, guard)).toMatchObject({ serverValidated: true, budgetDeltas: [], coercions: [], fieldChanges: [{ field: 'Label name', before: '(new)', after: 'New label' }, { field: 'Background color', before: '(new)', after: '#abc' }, { field: 'Description', before: '(new)', after: 'Description' }], notes: [expect.stringContaining('no pause state')] });
    expect(writes(f)[0]).toMatchObject({ url: `https://googleads.googleapis.com/v25/customers/${account}/labels:mutate`, body: { operations: [{ create: { name: 'New label', textLabel: { backgroundColor: '#abc', description: 'Description' } } }], validateOnly: true, partialFailure: false } });
    expect(await f.provider.applyWrite(operation, guard)).toEqual({ applied: true, resourceIds: [resource] });
    expect(writes(f)[1]!.body.validateOnly).toBe(false);
  });

  it('updates only supplied masks, preserves omitted fields and clears an explicit empty description', async () => {
    const f = fixture(), current = await f.provider.labels.get(account, labelId);
    await f.provider.previewWrite(op('google_update_label', { label_id: labelId, expected_label_hash: current.snapshot_hash, name: 'Renamed' }), guard);
    expect(writes(f)[0]!.body.operations).toEqual([{ update: { resourceName: resource, name: 'Renamed' }, updateMask: 'name' }]);
    const preview = await f.provider.previewWrite(op('google_update_label', { label_id: labelId, expected_label_hash: current.snapshot_hash, description: '', background_color: '#fedcba' }), guard);
    expect(preview.fieldChanges).toEqual([{ field: 'Background color', before: '#123456', after: '#fedcba' }, { field: 'Description', before: 'Preserved description', after: '' }]);
    expect(writes(f)[1]!.body.operations).toEqual([{ update: { resourceName: resource, textLabel: { description: '', backgroundColor: '#fedcba' } }, updateMask: 'text_label.background_color,text_label.description' }]);
    await f.provider.previewWrite(op('google_remove_label', { label_id: labelId, expected_label_hash: current.snapshot_hash }, 'remove'), guard);
    expect(writes(f)[2]!.body.operations).toEqual([{ remove: resource }]);
  });

  it.each(targetCases)('assigns and unassigns the exact native composite relation for %j', async (target, key, service, relation, entity, composite) => {
    const f = fixture(), current = await f.provider.labels.get(account, labelId), payload = { target, label_id: labelId, expected_label_hash: current.snapshot_hash };
    const nativeResource = `customers/${account}/${service}/${composite}~${labelId}`;
    await f.provider.previewWrite(op('google_link_label', payload, 'create'), guard);
    expect(writes(f)[0]!.url).toBe(`https://googleads.googleapis.com/v25/customers/${account}/${service}:mutate`);
    expect(writes(f)[0]!.body).toEqual({ validateOnly: true, partialFailure: false, operations: [{ create: { label: resource, [relation]: `customers/${account}/${entity}` } }] });
    f.state.links = [{ [key]: { resourceName: nativeResource, label: resource, [relation]: `customers/${account}/${entity}` } }];
    expect(await f.provider.labels.listAssociations({ account_id: account, target, limit: 1 })).toEqual({ associations: [f.state.links[0]![key]], truncated: false });
    await f.provider.previewWrite(op('google_unlink_label', payload, 'remove'), guard);
    expect(writes(f)[1]!.body.operations).toEqual([{ remove: nativeResource }]);
    expect(await f.provider.applyWrite(op('google_unlink_label', payload, 'remove'), guard)).toEqual({ applied: true, resourceIds: [nativeResource] });
    if (target.type !== 'CAMPAIGN') expect(f.calls.some(call => String(call.body.query).includes('campaign.id = 11') && String(call.body.query).includes('ad_group.id = 22'))).toBe(true);
  });

  it('refuses another parent, duplicate and missing assignments, or a forged returned association', async () => {
    const f = fixture(), current = await f.provider.labels.get(account, labelId), target = targetCases[1][0], payload = { target, label_id: labelId, expected_label_hash: current.snapshot_hash };
    f.state.wrongParent = true;
    await expect(f.provider.previewWrite(op('google_link_label', payload, 'create'), guard)).rejects.toThrow('parent hierarchy');
    f.state.wrongParent = false;
    await expect(f.provider.previewWrite(op('google_unlink_label', payload, 'remove'), guard)).rejects.toThrow('not found');
    f.state.links = [{ adGroupLabel: { resourceName: `customers/${account}/adGroupLabels/22~${labelId}`, label: resource, adGroup: `customers/${account}/adGroups/22` } }];
    await expect(f.provider.previewWrite(op('google_link_label', payload, 'create'), guard)).rejects.toThrow('already exists');
    (f.state.links[0]!.adGroupLabel as Row).adGroup = `customers/${account}/adGroups/99`;
    await expect(f.provider.previewWrite(op('google_unlink_label', payload, 'remove'), guard)).rejects.toThrow('identity mismatch');
    expect(writes(f)).toEqual([]);
  });

  it('rejects a stale metadata snapshot before any native mutation and retains an unconfirmed receipt', async () => {
    const f = fixture(), current = await f.provider.labels.get(account, labelId); f.state.label.name = 'Changed elsewhere';
    await expect(f.provider.previewWrite(op('google_remove_label', { label_id: labelId, expected_label_hash: current.snapshot_hash }, 'remove'), guard)).rejects.toThrow('metadata changed');
    expect(writes(f)).toEqual([]);
    f.state.badReceipt = true;
    await expect(f.provider.applyWrite(op('google_create_label', { name: 'New' }, 'create'), guard)).rejects.toMatchObject({ details: { resource_ids: ['customers/9999999999/labels/42'] } });
    expect(writes(f)).toHaveLength(1);
  });

  it('keeps registry writes behind pending tokens and rejects changed args or changed native metadata before apply', async () => {
    const f = fixture(), pending = new Map<string, PendingOperation>();
    const engine = new PolicyEngine(DEFAULT_POLICY, { async sweep() {}, async put(value) { pending.set(value.id, value); }, async get(id) { return pending.get(id); }, async delete(id) { pending.delete(id); } }, { async append() {} });
    const runtime = await createContext({ engine, providerModules: [{ provider: f.provider, tools: googleTools(f.provider) }] });
    const current = await f.provider.labels.get(account, labelId), args = { account_id: account, label_id: labelId, expected_label_hash: current.snapshot_hash, name: 'New metadata' };
    const preview = await runtime.registry.call('google_update_label', args, runtime.ctx) as { applied: boolean; pending_operation_id: string };
    expect(preview.applied).toBe(false); expect(writes(f).every(value => value.body.validateOnly === true)).toBe(true);
    await expect(runtime.registry.call('google_update_label', { ...args, name: 'Changed args', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    f.state.label.name = 'Changed natively';
    await expect(runtime.registry.call('google_update_label', { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow('metadata changed');
    expect(writes(f).every(value => value.body.validateOnly === true)).toBe(true);
  });
});

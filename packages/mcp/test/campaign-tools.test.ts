import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, DEFAULT_POLICY, PendingStore, PolicyEngine, createContext, selectRuntimeCatalog, withProjectRouting, type AdProvider } from '@adport/core';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { providerModules } from './provider-fixtures.js';
import { createMcpServer } from '../src/index.js';

const preview = { summary: 'Campaign status', changes: [], coercions: [], budgetDeltas: [], serverValidated: false };
const campaignCases = [
  ['apple', 'status', 'ENABLED', 'PAUSED'],
  ['google', 'status', 'ENABLED', 'PAUSED'],
  ['gravity', 'status', 'active', 'paused'],
  ['linkedin', 'status', null, 'PAUSED'],
  ['meta', 'status', 'ACTIVE', 'PAUSED'],
  ['microsoft', 'status', 'Active', 'Paused'],
  ['openai', 'status', 'active', 'paused'],
  ['pinterest', 'status', 'ACTIVE', 'PAUSED'],
  ['reddit', 'configured_status', 'ACTIVE', 'PAUSED'],
  ['snapchat', 'status', 'ACTIVE', 'PAUSED'],
  ['spotify', 'status', 'ACTIVE', 'PAUSED'],
  ['tiktok', 'operation_status', 'ENABLE', 'DISABLE'],
  ['x', 'status', 'ACTIVE', 'PAUSED'],
] as const;

let data: string;
beforeEach(async () => { data = await mkdtemp(join(tmpdir(), 'adport-campaign-tool-')); });
afterEach(async () => { await rm(data, { recursive: true, force: true }); });

async function runtime(directory = data) {
  const engine = new PolicyEngine(DEFAULT_POLICY, new PendingStore(directory), new AuditLog(directory));
  return createContext({ providerModules: providerModules(), engine });
}

it.each(campaignCases)('translates shared campaign status into the real %s write schema before preview', async (provider, field, active, paused) => {
  const context = await runtime();
  const selected = selectRuntimeCatalog(context, { profile: 'standard', providers: [provider] });
  const adapter = context.ctx.providers.get(provider);
  const call = vi.spyOn(adapter, 'previewWrite').mockResolvedValue(preview);
  const apply = vi.spyOn(adapter, 'applyWrite');
  const id = provider === 'spotify' ? '11111111-1111-4111-8111-111111111111' : '1234567890';
  const args = { provider, account_id: id, campaign_id: id };
  await expect(selected.registry.call('campaign_set_status', { ...args, status: 'paused' }, selected.ctx)).resolves.toMatchObject({ status: 'pending_validation' });
  const identifiers = provider === 'tiktok' ? { campaign_ids: [id] } : { campaign_id: id };
  expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ tool: provider + '_set_campaign_status', accountId: id, payload: { ...identifiers, [field]: paused } }), expect.any(Object));
  if (active) {
    await selected.registry.call('campaign_set_status', { ...args, status: 'active' }, selected.ctx);
    expect(call).toHaveBeenLastCalledWith(expect.objectContaining({ payload: { ...identifiers, [field]: active } }), expect.any(Object));
  } else {
    await expect(selected.registry.call('campaign_set_status', { ...args, status: 'active' }, selected.ctx)).rejects.toThrow(/advertiser consent/);
    expect(call).toHaveBeenCalledTimes(1);
  }
  expect(apply).not.toHaveBeenCalled();
});

it('binds approval to the shared operation, provider, account and exact status', async () => {
  const context = await runtime();
  const meta = context.ctx.providers.get('meta'), google = context.ctx.providers.get('google');
  vi.spyOn(meta, 'previewWrite').mockResolvedValue(preview);
  const apply = vi.spyOn(meta, 'applyWrite').mockResolvedValue({ applied: true, resourceIds: ['1234'] });
  const other = vi.spyOn(google, 'applyWrite');
  const args = { provider: 'meta', account_id: '1234567890', campaign_id: '1234', status: 'paused' };
  const result = await context.registry.call('campaign_set_status', args, context.ctx) as { pending_operation_id: string };
  const approved = { ...args, pending_operation_id: result.pending_operation_id };
  for (const change of [{ provider: 'google' }, { account_id: '1111111111' }, { campaign_id: '9999' }, { status: 'active' }]) {
    await expect(context.registry.call('campaign_set_status', { ...approved, ...change }, context.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  }
  await expect(context.registry.call('meta_set_campaign_status', {
    account_id: args.account_id, campaign_id: args.campaign_id, status: 'PAUSED', pending_operation_id: result.pending_operation_id,
  }, context.ctx)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
  expect(apply).not.toHaveBeenCalled();
  expect(other).not.toHaveBeenCalled();
  await expect(context.registry.call('campaign_set_status', approved, context.ctx)).resolves.toMatchObject({ applied: true });
  await expect(context.registry.call('campaign_set_status', approved, context.ctx)).rejects.toMatchObject({ code: 'PENDING_NOT_FOUND' });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(await new AuditLog(data).read()).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'validated', tool: 'campaign_set_status', provider: 'meta', accountId: args.account_id }),
    expect.objectContaining({ event: 'applied', tool: 'campaign_set_status', provider: 'meta', accountId: args.account_id }),
  ]));
});

it('keeps a hosted approval tied to its project and echoes the approval arguments in the MCP widget', async () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const selection = { profile: 'standard', providers: ['meta'] } as const;
  const projects = new Map([
    [first, selectRuntimeCatalog(await runtime(join(data, 'first')), selection)],
    [second, selectRuntimeCatalog(await runtime(join(data, 'second')), selection)],
  ]);
  const target = projects.get(first)!;
  const meta = target.ctx.providers.get('meta');
  vi.spyOn(meta, 'previewWrite').mockResolvedValue(preview);
  const apply = vi.spyOn(meta, 'applyWrite').mockResolvedValue({ applied: true, resourceIds: ['1234'] });
  const other = vi.spyOn(projects.get(second)!.ctx.providers.get('meta'), 'applyWrite');
  const routed = withProjectRouting(target, {
    list: async () => [...projects.keys()].map(id => ({ id, name: id, organization_name: 'Workspace', role: 'owner', providers: ['meta'] })),
    resolve: async id => projects.get(id)!,
  });
  const server = createMcpServer({ runtime: routed, productionOnly: true });
  const client = new Client({ name: 'campaign-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    await client.listTools();
    const name = 'campaign_set_status';
    const args = { project_id: first, provider: 'meta', account_id: '1234567890', campaign_id: '1234', status: 'paused' };
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      applied: false,
      _adport: { provider: 'meta', accountId: args.account_id, approval: { arguments: args } },
    });
    const pending = (result.structuredContent as { pending_operation_id?: string } | undefined)?.pending_operation_id;
    expect(typeof pending).toBe('string');
    const rejected = await client.callTool({ name, arguments: { ...args, project_id: second, pending_operation_id: pending } });
    expect(rejected.isError).toBe(true);
    expect(other).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    const confirmed = await client.callTool({ name, arguments: { ...args, pending_operation_id: pending } });
    expect(confirmed.structuredContent).toMatchObject({ applied: true });
    expect(apply).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});

it('normalizes campaign inventory through the scoped native reads, including GAQL and native IDs', async () => {
  const context = await runtime();
  const google = context.ctx.providers.get('google') as AdProvider & { gaqlSearch(): Promise<unknown> };
  const meta = context.ctx.providers.get('meta') as AdProvider & { listCampaigns(): Promise<unknown> };
  const googleRead = vi.spyOn(google, 'gaqlSearch').mockResolvedValue([
    { campaign: { id: '1', name: 'Search', status: 'ENABLED' } },
    { campaign: { id: '2', name: 'Brand', status: 'PAUSED' } },
  ]);
  const metaRead = vi.spyOn(meta, 'listCampaigns').mockResolvedValue({ campaigns: [{ id: '3', name: 'Meta', status: 'ACTIVE' }] });
  const selected = selectRuntimeCatalog(context, { profile: 'standard', providers: ['google'] });
  const input = { provider: 'google', account_id: '1234567890', limit: 1 };
  await expect(selected.registry.call('campaigns_list', input, selected.ctx)).resolves.toEqual({
    provider: 'google', account_id: '1234567890', campaigns: [{ id: '1', name: 'Search', status: 'ENABLED' }], truncated: true,
  });
  expect(googleRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    customer_id: '1234567890', resource: 'campaign', fields: ['campaign.id', 'campaign.name', 'campaign.status'], limit: 2,
  }));
  await expect(selected.registry.call('campaigns_list', { ...input, provider: 'meta' }, selected.ctx)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  expect(metaRead).not.toHaveBeenCalled();
  await expect(context.registry.call('campaigns_list', { ...input, provider: 'meta' }, context.ctx)).resolves.toMatchObject({
    campaigns: [{ id: '3', name: 'Meta', status: 'ACTIVE' }], truncated: false,
  });
});

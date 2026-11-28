import { z } from 'zod';
import { AdportError } from '../errors.js';
import type { AdProvider, WriteOperation } from '../provider.js';
import { campaignMapping, type CampaignProvider } from './campaign-mappings.js';
import { defineTool, type ToolRegistry, type AnyToolDefinition } from './registry.js';
import { guardedWriteTool } from './write.js';

const id = z.string().min(1).max(200);
const campaign = z.object({
  id,
  name: z.string().nullable(),
  status: z.string().nullable().describe('Configured status reported by the provider.'),
});
const campaignsOutput = z.object({
  provider: z.string(),
  account_id: id,
  campaigns: z.array(campaign),
  truncated: z.boolean(),
});
const record = z.record(z.string(), z.unknown());
const rows = z.array(record);
const campaignId = z.union([id, z.number().int().nonnegative().safe()]).transform(value => String(value));
const defaultFields = ['id', 'name', 'status'] as const;
const catalog = { category: 'campaigns', exposure: 'standard' } as const;

function campaignRead(provider: CampaignProvider, accountId: string, limit: number) {
  if (provider === 'google') return {
    customer_id: accountId,
    resource: 'campaign',
    fields: ['campaign.id', 'campaign.name', 'campaign.status'],
    order_by: ['campaign.id ASC'],
    limit: limit + 1,
  };
  return { account_id: accountId, ...(provider === 'apple' || provider === 'meta' ? { limit: limit + 1 } : {}) };
}

function nativeStatusProvider(registry: ToolRegistry, provider: AdProvider, source: CampaignProvider,
  accountId: string, campaignId: string, status: 'active' | 'paused'): AdProvider {
  if (source === 'linkedin' && status === 'active') {
    throw new AdportError('INVALID_INPUT', 'Use linkedin_set_campaign_status for activation with explicit advertiser consent.');
  }
  const action = provider.standardActions?.().pauseCampaign?.(accountId, campaignId);
  if (action?.tool !== source + '_set_campaign_status') {
    throw new AdportError('INVALID_INPUT', 'Campaign status changes are unavailable on this provider connection.');
  }
  const definition = registry.get(action.tool);
  const [field, value] = campaignMapping(source).activation ?? ['status', 'ACTIVE'];
  const nativeInput = definition.input.safeParse({ ...action.input, ...(status === 'active' ? { [field]: value } : {}) });
  if (!nativeInput.success || nativeInput.data.account_id !== accountId || definition.namespace !== source || definition.annotations.readOnly !== false) {
    throw new AdportError('INVALID_INPUT', 'Invalid account or campaign ID for ' + source + '.');
  }
  const { account_id: _accountId, pending_operation_id: _pending, ...payload } = nativeInput.data;
  // The policy engine signs and audits the shared operation. The provider plans
  // the exact native action under the same account and approval.
  const native = (operation: WriteOperation): WriteOperation => ({ ...operation, tool: action.tool, payload });
  return {
    id: provider.id,
    capabilities: () => provider.capabilities(),
    listAccounts: () => provider.listAccounts(),
    report: query => provider.report(query),
    previewWrite: (operation, guard) => provider.previewWrite(native(operation), guard),
    applyWrite: (operation, guard) => provider.applyWrite(native(operation), guard),
  };
}

export function campaignTools(registry: ToolRegistry, sources: readonly CampaignProvider[],
  writeSources: readonly CampaignProvider[]): AnyToolDefinition[] {
  if (!sources.length) return [];

  const tools = [defineTool({
    name: 'campaigns_list', namespace: 'campaigns', sourceProviders: sources, catalog,
    description: 'List campaign IDs, names and configured status for one provider and ad account. A truncated result may omit campaigns.',
    input: z.strictObject({
      provider: z.enum(sources),
      account_id: id,
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: campaignsOutput,
    presentation: 'records',
    annotations: { readOnly: true, openWorld: false },
    async handler({ provider, account_id, limit }, ctx) {
      ctx.providers.get(provider);
      const mapping = campaignMapping(provider);
      const tool = registry.get(mapping.list);
      if (tool.namespace !== provider || !tool.annotations.readOnly) {
        throw new AdportError('INVALID_INPUT', 'Campaign listing is unavailable on this provider connection.');
      }
      const result = await registry.call(tool.name, campaignRead(provider, account_id, limit), ctx);
      const data = rows.safeParse(mapping.collection ? record.safeParse(result).data?.[mapping.collection] : result);
      if (!data.success) throw new AdportError('PROVIDER_ERROR', 'The provider returned an invalid campaign list.');
      const [idField, nameField, statusField] = mapping.fields ?? defaultFields;
      const campaigns = data.data.slice(0, limit).map(row => {
        const entry = provider === 'google' ? record.safeParse(row.campaign).data : row;
        const parsed = campaignId.safeParse(entry?.[idField]);
        if (!parsed.success) throw new AdportError('PROVIDER_ERROR', 'The provider returned a campaign without a valid ID.');
        const name = entry?.[nameField], status = entry?.[statusField];
        return { id: parsed.data, name: typeof name === 'string' ? name : null, status: typeof status === 'string' ? status : null };
      });
      return {
        provider, account_id, campaigns,
        // TikTok's native list returns only the first 100 campaigns.
        truncated: data.data.length > limit || (provider === 'tiktok' && data.data.length >= 100),
      };
    },
  })];
  if (writeSources.length) tools.push(guardedWriteTool({
    name: 'campaign_set_status', namespace: 'campaigns', sourceProviders: writeSources, catalog,
    description: 'Pause or activate one campaign. For LinkedIn activation, use linkedin_set_campaign_status with advertiser consent.',
    provider: 'campaigns', kind: 'update', openWorld: false,
    payload: z.strictObject({
      provider: z.enum(writeSources),
      account_id: id,
      campaign_id: id,
      status: z.enum(['paused', 'active']),
    }),
    contextTarget(ctx, input) {
      return { accountId: input.account_id, provider: nativeStatusProvider(registry, ctx.providers.get(input.provider),
        input.provider, input.account_id, input.campaign_id, input.status) };
    },
  }));
  return tools;
}

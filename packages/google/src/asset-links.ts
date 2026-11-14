import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';
import type { GoogleAssetPlan, GoogleAssetService } from './assets.js';

type Row = Record<string, unknown>;
const id = z.string().regex(/^\d+$/), scope = z.enum(['CUSTOMER', 'CAMPAIGN', 'AD_GROUP']);
const field = z.enum(['SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'AD_IMAGE', 'BUSINESS_LOGO', 'BUSINESS_NAME']);
const base = { scope, parent_id: id.optional() };
const target = z.object(base).refine(input => input.scope === 'CUSTOMER' ? !input.parent_id : Boolean(input.parent_id), 'Use no parent_id for CUSTOMER; provide the campaign/ad-group ID for other scopes');
const linkInput = target.safeExtend({ asset_id: id, field_type: field, status: z.enum(['PAUSED', 'ENABLED']).default('PAUSED') });
const statusInput = target.safeExtend({ asset_id: id, field_type: field, status: z.enum(['PAUSED', 'ENABLED']) });
const removeInput = target.safeExtend({ asset_id: id, field_type: field });
export const GOOGLE_ASSET_LINK_WRITES = new Set(['google_link_asset', 'google_set_asset_link_status', 'google_unlink_asset']);
const configs: Record<z.infer<typeof scope>, { resource: string; key: string; service: string; parent?: string; parentService?: string }> = {
  CUSTOMER: { resource: 'customer_asset', key: 'customerAsset', service: 'customerAssets' },
  CAMPAIGN: { resource: 'campaign_asset', key: 'campaignAsset', service: 'campaignAssets', parent: 'campaign', parentService: 'campaigns' },
  AD_GROUP: { resource: 'ad_group_asset', key: 'adGroupAsset', service: 'adGroupAssets', parent: 'ad_group', parentService: 'adGroups' },
};
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export class GoogleAssetLinks {
  constructor(private readonly client: GoogleAdsRestClient, private readonly assets: GoogleAssetService) {}
  private async parent(account: string, input: z.infer<typeof target>) {
    const config = configs[input.scope];
    if (!config.parent) return;
    const expected = `customers/${account}/${config.parentService}/${input.parent_id}`;
    const rows = await this.client.search(account, `SELECT ${config.parent}.id, ${config.parent}.resource_name, ${config.parent}.status FROM ${config.parent} WHERE ${config.parent}.id = ${input.parent_id} LIMIT 2`, { maxRows: 2, includeDrafts: true });
    const key = config.parent === 'ad_group' ? 'adGroup' : 'campaign', value = record(rows[0]?.[key]);
    if (rows.length !== 1 || value.resourceName !== expected || !['ENABLED', 'PAUSED'].includes(String(value.status))) throw new AdportError('INVALID_INPUT', 'google: asset-link parent is not an available entity in this account');
  }
  private async rows(account: string, input: z.infer<typeof target>, assetId?: string, fieldType?: string, limit = 2) {
    const c = configs[input.scope], conditions = [`${c.resource}.status != 'REMOVED'`];
    if (c.parent) conditions.push(`${c.resource}.${c.parent} = 'customers/${account}/${c.parentService}/${input.parent_id}'`);
    if (assetId) conditions.push(`${c.resource}.asset = 'customers/${account}/assets/${assetId}'`);
    if (fieldType) conditions.push(`${c.resource}.field_type = '${fieldType}'`);
    return (await this.client.search(account, `SELECT ${c.resource}.resource_name, ${c.resource}.asset, ${c.resource}.field_type, ${c.resource}.status FROM ${c.resource} WHERE ${conditions.join(' AND ')} LIMIT ${limit}`, { maxRows: limit, includeDrafts: input.scope !== 'CUSTOMER' })).map(row => record(row[c.key]));
  }
  async list(input: z.infer<typeof target> & { account_id: string; limit: number }) {
    const account = normalizeCustomerId(input.account_id), parsed = target.parse(input);
    await this.parent(account, parsed);
    const rows = await this.rows(account, parsed, undefined, undefined, input.limit + 1), c = configs[input.scope];
    if (rows.some(row => typeof row.resourceName !== 'string' || !row.resourceName.startsWith(`customers/${account}/${c.service}/${input.parent_id ? `${input.parent_id}~` : ''}`) || typeof row.asset !== 'string' || !new RegExp(`^customers/${account}/assets/\\d+$`).test(row.asset))) throw new AdportError('PROVIDER_ERROR', 'google: asset-link list returned another account or parent');
    return { links: rows.slice(0, input.limit), truncated: rows.length > input.limit };
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<GoogleAssetPlan> {
    if (!GOOGLE_ASSET_LINK_WRITES.has(op.tool)) throw new AdportError('INVALID_INPUT', 'google: unsupported asset-link write');
    const account = normalizeCustomerId(op.accountId), creating = op.tool === 'google_link_asset', removing = op.tool === 'google_unlink_asset';
    if (op.provider !== 'google' || op.kind !== (creating ? 'create' : removing ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'google: asset-link operation kind mismatch');
    const input = removing ? removeInput.parse(op.payload) : creating ? linkInput.parse(op.payload) : statusInput.parse(op.payload), c = configs[input.scope];
    await this.parent(account, input);
    const asset = await this.assets.owned(account, input.asset_id);
    const wanted = { SITELINK: 'SITELINK', CALLOUT: 'CALLOUT', STRUCTURED_SNIPPET: 'STRUCTURED_SNIPPET', AD_IMAGE: 'IMAGE', BUSINESS_LOGO: 'IMAGE', BUSINESS_NAME: 'TEXT' }[input.field_type];
    if (asset.type !== wanted) throw new AdportError('INVALID_INPUT', 'google: asset type is incompatible with this association field');
    const resource = `customers/${account}/${c.service}/${input.parent_id ? `${input.parent_id}~` : ''}${input.asset_id}~${input.field_type}`;
    const current = await this.rows(account, input, input.asset_id, input.field_type);
    if (current.length > 1 || current.some(row => row.resourceName !== resource || row.asset !== `customers/${account}/assets/${input.asset_id}` || row.fieldType !== input.field_type)) throw new AdportError('PROVIDER_ERROR', 'google: asset association identity mismatch');
    if (creating ? current.length !== 0 : current.length !== 1) throw new AdportError('INVALID_INPUT', creating ? 'google: association already exists; use its status tool' : 'google: active or paused asset association was not found');
    const requested = 'status' in input ? input.status : undefined, status = creating && guard.forcePausedCreation ? 'PAUSED' : requested;
    const coercions = creating && status !== requested ? ['asset-link status coerced to PAUSED by policy (paused_creation)'] : [];
    const operation = removing ? { remove: resource } : creating ? { create: { asset: `customers/${account}/assets/${input.asset_id}`, fieldType: input.field_type, status, ...(c.parent ? { [c.parent === 'ad_group' ? 'adGroup' : c.parent]: `customers/${account}/${c.parentService}/${input.parent_id}` } : {}) } } : { update: { resourceName: resource, status }, updateMask: 'status' };
    return { summary: `${removing ? 'Remove' : creating ? 'Create' : 'Update'} Google ${input.scope} asset association`, changes: [`${creating ? '+' : removing ? '-' : '~'} ${resource}; ${removing ? 'remove association' : `${current[0]?.status ?? 'absent'} → ${status}`}`, 'Asset bytes and content are retained. This affects every serving use of this association; parent ad and campaign statuses are unchanged.'], coercions, budgetDeltas: [], execute: async validateOnly => {
      const result = await this.client.mutate(account, c.service, [operation], { validateOnly });
      const resources = (result.results ?? []).flatMap(value => value.resourceName ? [value.resourceName] : []);
      if (!validateOnly && (resources.length !== 1 || resources[0] !== resource)) throw new AdportError('PROVIDER_ERROR', 'google: asset-association mutation receipt mismatch; reconcile before retrying', { resource_ids: resources });
      return resources;
    } };
  }
}

export function googleAssetLinkTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove') => guardedWriteTool({ name, namespace: 'google', provider: 'google', description, payload, kind });
  return [
    defineTool({ name: 'google_asset_links', namespace: 'google', description: 'Read shared asset associations for one customer, campaign or ad group. Removed associations are excluded; native field types and statuses are preserved.', input: target.safeExtend({ account_id: z.string(), limit: z.number().int().positive().max(200).default(50) }), output: z.object({ links: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() }), annotations: { readOnly: true }, handler: input => provider.assetLinks.list(input) }),
    write('google_link_asset', 'Attach an account-owned extension/image/branding asset to a customer, campaign or ad group. Defaults paused; paused-creation policy is reported. Native validation checks placement eligibility. Does not create an ad or change parents.', linkInput, 'create'),
    write('google_set_asset_link_status', 'Enable or pause an existing owned asset association. Enabling can change active ads that use this association; parent statuses are unchanged.', statusInput, 'update'),
    write('google_unlink_asset', 'Remove one exact asset association, preserving the asset itself. Changes every serving use of this association. Native server validation runs before approval.', removeInput, 'remove'),
  ];
}

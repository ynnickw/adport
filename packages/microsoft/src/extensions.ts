import { AdportError, creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition, type Creative, type WriteGuard, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { type MicrosoftAdsClient, type RequestScope } from './client.js';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRow as row, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const extensionType = z.enum(['CalloutAdExtension', 'SitelinkAdExtension', 'StructuredSnippetAdExtension', 'ImageAdExtension']);
const url = z.string().url().max(2048).refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; });
const urls = z.array(url).min(1).max(10);
const sitelink = { display_text: z.string().min(1).max(35), final_urls: urls, description1: z.string().max(35).optional(), description2: z.string().max(35).optional() };
const image = { alternative_text: z.string().min(1).max(35), image_ids: z.array(id).min(1).max(4), description: z.string().max(100).optional(), final_urls: urls.optional() };
const content = z.discriminatedUnion('extension_type', [
  z.object({ extension_type: z.literal('CalloutAdExtension'), text: z.string().min(1).max(25) }),
  z.object({ extension_type: z.literal('SitelinkAdExtension'), ...sitelink }),
  z.object({ extension_type: z.literal('StructuredSnippetAdExtension'), header: z.string().min(1).max(100), values: z.array(z.string().min(1).max(25)).min(3).max(10) }),
  z.object({ extension_type: z.literal('ImageAdExtension'), ...image }),
]);
const fields: Record<string, string> = { text: 'Text', display_text: 'DisplayText', final_urls: 'FinalUrls', description1: 'Description1', description2: 'Description2', header: 'Header', values: 'Values', alternative_text: 'AlternativeText', image_ids: 'ImageMediaIds', description: 'Description' };
const labels: Record<string, string> = { Text: 'Callout text', DisplayText: 'Link text', FinalUrls: 'Landing pages', Description1: 'Description 1', Description2: 'Description 2', Header: 'Localized header', Values: 'Snippet values', AlternativeText: 'Alternative text', ImageMediaIds: 'Source images', Description: 'Internal description' };
const reviewValue = (value: unknown): string => value === null || value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value);
const reference = z.object({ extension_id: id, extension_type: extensionType });
const versioned = reference.extend({ expected_version: z.number().int().positive() });
const update = versioned.extend({
  text: z.string().min(1).max(25).optional(), ...z.object(sitelink).partial().shape,
  header: z.string().min(1).max(100).optional(), values: z.array(z.string().min(1).max(25)).min(3).max(10).optional(), ...z.object(image).partial().shape,
}).superRefine((value, ctx) => {
  const allowed: Record<string, string[]> = { CalloutAdExtension: ['text'], SitelinkAdExtension: Object.keys(sitelink), StructuredSnippetAdExtension: ['header', 'values'], ImageAdExtension: Object.keys(image) };
  const supplied = Object.keys(fields).filter(key => value[key as keyof typeof value] !== undefined);
  if (!supplied.length || supplied.some(key => !allowed[value.extension_type]!.includes(key))) ctx.addIssue({ code: 'custom', message: 'Supply content changes supported by this extension type' });
});
const target = z.discriminatedUnion('type', [z.object({ type: z.literal('Account') }), z.object({ type: z.literal('Campaign'), campaign_id: id }), z.object({ type: z.literal('AdGroup'), campaign_id: id, ad_group_id: id })]);
type Target = z.infer<typeof target>;
const mutable: Record<z.infer<typeof extensionType>, string[]> = {
  CalloutAdExtension: ['Text', 'Scheduling'],
  SitelinkAdExtension: ['DisplayText', 'Description1', 'Description2', 'DestinationUrl', 'DevicePreference', 'Scheduling', 'FinalUrls', 'FinalMobileUrls', 'FinalUrlSuffix', 'TrackingUrlTemplate', 'UrlCustomParameters'],
  StructuredSnippetAdExtension: ['Header', 'Values', 'Scheduling'],
  ImageAdExtension: ['AlternativeText', 'Description', 'DestinationUrl', 'DisplayText', 'FinalUrls', 'FinalMobileUrls', 'FinalUrlSuffix', 'TrackingUrlTemplate', 'UrlCustomParameters', 'ImageMediaIds', 'Images', 'Layouts', 'Scheduling'],
};
const allowedReadOnly = ['Id', 'Version', 'Type', 'Status', 'ForwardCompatibilityMap', 'FinalAppUrls', 'SourceType', 'DevicePreference'];
const extensionOutput = creativesOutput.extend({ extensions: z.array(z.record(z.string(), z.unknown())) });
export const MICROSOFT_EXTENSION_WRITES = new Set(['microsoft_create_ad_extension', 'microsoft_update_ad_extension', 'microsoft_delete_ad_extension', 'microsoft_link_ad_extension', 'microsoft_unlink_ad_extension']);

/** REST contracts pinned at MicrosoftDocs/Advertising@fdee2fcf; flags use native REST CSV. */
export class MicrosoftExtensionService extends MicrosoftNativeService {
  constructor(client: MicrosoftAdsClient, scope: (account: string) => Promise<RequestScope>, campaign: (account: string, campaign: string) => Promise<unknown>, private readonly imageLookup: (account: string, ids: string[]) => Promise<{ creatives: Creative[]; missing_image_ids: string[] }>) { super(client, scope, campaign); }

  async getRaw(account: string, extensionId: string, type: z.infer<typeof extensionType>): Promise<Row> {
    const result = await this.request(account, 'AdExtensions/QueryByIds', { AccountId: account, AdExtensionIds: [extensionId], AdExtensionType: type });
    const values = rows(result.AdExtensions);
    if (values.length !== 1 || nativeId(values[0]!.Id) !== extensionId || values[0]!.Type !== type) throw new AdportError('INVALID_INPUT', 'microsoft: extension was not found with this type in the selected account');
    if (!Number.isSafeInteger(values[0]!.Version) || Number(values[0]!.Version) < 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension version was not returned');
    return values[0]!;
  }

  private card(account: string, value: Row): Creative {
    if (!Number.isSafeInteger(value.Version) || Number(value.Version) < 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension version was not returned');
    const type = extensionType.parse(value.Type), extensionId = nativeId(value.Id), args = { account_id: account, extension_id: extensionId, extension_type: type, expected_version: value.Version };
    const text = (key: string) => typeof value[key] === 'string' ? String(value[key]) : '';
    const edit: Creative['actions'][number] = { label: 'Edit shared extension', tool: 'microsoft_update_ad_extension', arguments: args, fields: [] };
    if (type === 'CalloutAdExtension') edit.fields = [{ key: 'text', label: 'Callout text', type: 'text', value: text('Text'), max_length: 25 }];
    if (type === 'SitelinkAdExtension') edit.fields = [{ key: 'display_text', label: 'Link text', type: 'text', value: text('DisplayText'), max_length: 35 }, { key: 'description1', label: 'Description 1', type: 'text', value: text('Description1'), max_length: 35 }, { key: 'description2', label: 'Description 2', type: 'text', value: text('Description2'), max_length: 35 }, { key: 'final_urls', label: 'Landing pages (one per line)', type: 'url_list', value: Array.isArray(value.FinalUrls) ? value.FinalUrls.map(String) : [] }];
    if (type === 'StructuredSnippetAdExtension') edit.fields = [{ key: 'header', label: 'Localized header', type: 'text', value: text('Header') }, { key: 'values', label: 'Values (one per line)', type: 'text_list', value: Array.isArray(value.Values) ? value.Values.map(String) : [] }];
    if (type === 'ImageAdExtension') edit.fields = [{ key: 'alternative_text', label: 'Extension alternative text', type: 'text', value: text('AlternativeText'), max_length: 35 }, { key: 'description', label: 'Internal description', type: 'text', value: text('Description'), max_length: 100 }, { key: 'image_ids', label: 'Account image IDs (one per line)', type: 'text_list', value: this.imageIds(value) }];
    return { id: extensionId, provider: 'microsoft', account_id: account, type, name: text('Text') || text('DisplayText') || text('Header') || text('Description') || `Extension ${extensionId}`, status: typeof value.Status === 'string' ? value.Status : undefined, headlines: [text('Text') || text('DisplayText') || text('Header')].filter(Boolean), descriptions: [text('Description1'), text('Description2'), text('AlternativeText'), ...(Array.isArray(value.Values) ? value.Values.map(String) : [])].filter(Boolean), landing_urls: Array.isArray(value.FinalUrls) ? value.FinalUrls.filter(item => url.safeParse(item).success) as string[] : [], media: [], actions: [edit] };
  }

  private imageIds(value: Row): string[] {
    const ids = Array.isArray(value.ImageMediaIds) && value.ImageMediaIds.length ? value.ImageMediaIds.map(nativeId) : rows(value.Images).map(link => nativeId(row(link.Asset).Id));
    return [...new Set(ids)];
  }

  private async gallery(account: string, values: Row[], truncated: boolean, next?: string) {
    const creatives = values.map(value => this.card(account, value));
    const imageIds = [...new Set(values.filter(value => value.Type === 'ImageAdExtension').flatMap(value => this.imageIds(value)))];
    if (imageIds.length) {
      const previews = await this.imageLookup(account, imageIds), media = new Map(previews.creatives.map(value => [value.id, value.media]));
      for (const [index, value] of values.entries()) if (value.Type === 'ImageAdExtension') creatives[index]!.media = this.imageIds(value).flatMap(image => media.get(image) ?? []).map(preview => ({ ...preview, ...(typeof value.AlternativeText === 'string' ? { alt: value.AlternativeText } : {}) }));
    }
    return extensionOutput.parse({ extensions: values, creatives, truncated, ...(next ? { next_cursor: next } : {}) });
  }

  async get(input: { account_id: string; extension_id: string; extension_type: z.infer<typeof extensionType> }) {
    const value = await this.getRaw(input.account_id, input.extension_id, input.extension_type);
    return this.gallery(input.account_id, [value], false);
  }

  async list(input: { account_id: string; extension_types: Array<z.infer<typeof extensionType>>; after_extension_id?: string; limit: number }) {
    const result = await this.request(input.account_id, 'AdExtensionIds/QueryByAccountId', { AccountId: input.account_id, AdExtensionType: input.extension_types.join(', '), AssociationType: null });
    if (!Array.isArray(result.AdExtensionIds)) throw new AdportError('PROVIDER_ERROR', 'microsoft: account extension IDs were not returned');
    const ids = result.AdExtensionIds.map(nativeId).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    if (new Set(ids).size !== ids.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate native extension IDs');
    const remaining = ids.filter(value => !input.after_extension_id || BigInt(value) > BigInt(input.after_extension_id)), selected = remaining.slice(0, input.limit);
    let values: Row[] = [];
    if (selected.length) {
      const detail = await this.request(input.account_id, 'AdExtensions/QueryByIds', { AccountId: input.account_id, AdExtensionIds: selected, AdExtensionType: input.extension_types.join(', ') });
      values = rows(detail.AdExtensions);
      if (values.length !== selected.length || values.some((value, index) => nativeId(value.Id) !== selected[index] || !input.extension_types.includes(extensionType.parse(value.Type)))) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension page identity mismatch');
    }
    const truncated = remaining.length > selected.length;
    return this.gallery(input.account_id, values, truncated, truncated ? selected.at(-1) : undefined);
  }

  private async entity(account: string, value: Target) {
    if (value.type === 'Account') return { entityId: account, paused: false };
    const campaign = await this.campaign(account, value.campaign_id);
    if (value.type === 'Campaign') return { entityId: value.campaign_id, paused: campaign.Status === 'Paused' };
    const result = await this.request(account, 'AdGroups/QueryByIds', { CampaignId: value.campaign_id, AdGroupIds: [value.ad_group_id] });
    const groups = rows(result.AdGroups);
    if (groups.length !== 1 || nativeId(groups[0]!.Id) !== value.ad_group_id) throw new AdportError('INVALID_INPUT', 'microsoft: ad group was not found in the selected campaign/account');
    return { entityId: value.ad_group_id, paused: campaign.Status === 'Paused' || groups[0]!.Status === 'Paused' };
  }

  async associations(input: { account_id: string; target: Target; extension_type: z.infer<typeof extensionType> }) {
    const entity = await this.entity(input.account_id, input.target);
    const result = await this.request(input.account_id, 'AdExtensionsAssociations/Query', { AccountId: input.account_id, AdExtensionType: input.extension_type, AssociationType: input.target.type, EntityIds: [entity.entityId] });
    const collections = rows(result.AdExtensionAssociationCollection);
    if (collections.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension associations were not returned');
    const associations = rows(collections[0]!.AdExtensionAssociations);
    for (const value of associations) if (nativeId(value.EntityId) !== entity.entityId || value.AssociationType !== input.target.type || row(value.AdExtension).Type !== input.extension_type) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension association identity mismatch');
    return { associations, truncated: false };
  }

  private nativeContent(value: Record<string, unknown>) {
    const result: Row = { Type: value.extension_type };
    for (const [key, native] of Object.entries(fields)) if (value[key] !== undefined) result[native] = value[key];
    if (result.Type === 'SitelinkAdExtension') {
      const first = String(result.Description1 ?? ''), second = String(result.Description2 ?? '');
      if (Boolean(first) !== Boolean(second) || ((first || second) && String(result.DisplayText).length > 25)) throw new AdportError('INVALID_INPUT', 'microsoft: sitelink descriptions must be supplied together; links with descriptions have a 25-character text limit');
    }
    return result;
  }

  async plan(op: WriteOperation, guard: WriteGuard): Promise<MicrosoftPlan> {
    const expectedKind = op.tool === 'microsoft_create_ad_extension' || op.tool === 'microsoft_link_ad_extension' ? 'create' : op.tool === 'microsoft_delete_ad_extension' || op.tool === 'microsoft_unlink_ad_extension' ? 'remove' : 'update';
    if (op.provider !== 'microsoft' || !MICROSOFT_EXTENSION_WRITES.has(op.tool) || op.kind !== expectedKind) throw new AdportError('INVALID_INPUT', 'microsoft: extension operation kind mismatch');
    if (op.tool === 'microsoft_create_ad_extension') {
      const input = content.parse(op.payload.content), value = this.nativeContent(input);
      await this.verifyImages(op.accountId, value);
      return { summary: `Create unattached Microsoft ${input.extension_type}`, changes: [`+ ${JSON.stringify(value)}`, 'Extension status is natively Active; it cannot serve until associated. No association is created.', ...(input.extension_type === 'ImageAdExtension' ? ['Microsoft validates placement crop dimensions: an accepted library image can still be too small for an extension. This preview is not server-validated.'] : [])], coercions: [], budgetDeltas: [], execute: async () => {
        const result = await this.request(op.accountId, 'AdExtensions', { AccountId: op.accountId, AdExtensions: [value] });
        const identities = rows(result.AdExtensionIdentities), created = identities.map(value => nativeId(value.Id));
        if (created.length !== 1) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension creation receipt mismatch; reconcile before retrying', { resourceIds: created });
        await this.confirm(op.accountId, created[0]!, input.extension_type, value);
        return created;
      } };
    }
    const input = versioned.parse(op.payload), current = await this.getRaw(op.accountId, input.extension_id, input.extension_type);
    if (current.Version !== input.expected_version) throw new AdportError('PENDING_MISMATCH', 'microsoft: extension version changed; read it and request a fresh preview');
    if (op.tool === 'microsoft_update_ad_extension') {
      const change = update.parse(op.payload), supplied = this.nativeContent(change);
      if (Object.keys(supplied).length === 1) throw new AdportError('INVALID_INPUT', 'microsoft: supply at least one extension content change');
      const supported = mutable[input.extension_type];
      if (Object.keys(current).some(key => current[key] !== null && !supported.includes(key) && !allowedReadOnly.includes(key))) throw new AdportError('INVALID_INPUT', 'microsoft: extension contains unsupported fields; a safe full replacement cannot be built');
      const value: Row = { Type: input.extension_type, Id: input.extension_id, ...Object.fromEntries(supported.filter(key => current[key] !== undefined).map(key => [key, current[key]])), ...supplied };
      // Replacing ImageMediaIds must not retain the old Images array, which can override it.
      if (supplied.ImageMediaIds && JSON.stringify((supplied.ImageMediaIds as string[]).slice().sort()) !== JSON.stringify(this.imageIds(current).sort())) delete value.Images;
      if (Array.isArray(value.Images)) value.Images = value.Images.map(link => {
        const current = row(link), asset = row(current.Asset);
        const allowed = ['Id', 'Type', 'Name', 'CropHeight', 'CropWidth', 'CropX', 'CropY', 'CroppingType', 'SubType', 'TargetHeight', 'TargetWidth'];
        if (Object.keys(asset).some(key => asset[key] != null && !allowed.includes(key) && key !== 'Excluded')) throw new AdportError('INVALID_INPUT', 'microsoft: unsupported image crop fields prevent a safe extension update');
        return { Asset: Object.fromEntries(allowed.filter(key => asset[key] !== undefined).map(key => [key, asset[key]])), ...(current.PinnedField != null ? { PinnedField: current.PinnedField } : {}) };
      });
      await this.verifyImages(op.accountId, value);
      if (input.extension_type === 'SitelinkAdExtension') this.nativeContent({ extension_type: input.extension_type, display_text: value.DisplayText, description1: value.Description1, description2: value.Description2 });
      const impact = 'Every entity using this extension can change, including active ads. Existing scheduling, device preference and tracking fields are preserved. Native extension Version is read-only.';
      const fieldChanges = Object.keys(supplied).filter(key => key !== 'Type').flatMap(key => {
        const before = key === 'ImageMediaIds' ? this.imageIds(current) : current[key], after = supplied[key];
        return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [{ field: labels[key] ?? key, before: reviewValue(before), after: reviewValue(after) }];
      });
      return { summary: `Update shared Microsoft extension ${input.extension_id}`, changes: [`~ ${JSON.stringify(current)} → ${JSON.stringify(value)}`, impact], fieldChanges, notes: [impact], coercions: [], budgetDeltas: [], execute: async () => {
        await this.request(op.accountId, 'AdExtensions', { AccountId: op.accountId, AdExtensions: [value] }, 'PUT');
        await this.confirm(op.accountId, input.extension_id, input.extension_type, value, input.expected_version);
        return [input.extension_id];
      } };
    }
    if (op.tool === 'microsoft_delete_ad_extension') return { summary: `Delete shared Microsoft extension ${input.extension_id}`, changes: [`- ${JSON.stringify(current)}`, 'Permanent deletion removes this shared extension and affects every associated entity. Uploaded source images remain in the media library.'], coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(op.accountId, 'AdExtensions', { AccountId: op.accountId, AdExtensionIds: [input.extension_id] }, 'DELETE');
      const result = await this.request(op.accountId, 'AdExtensionIds/QueryByAccountId', { AccountId: op.accountId, AdExtensionType: input.extension_type, AssociationType: null });
      if (!Array.isArray(result.AdExtensionIds) || result.AdExtensionIds.map(nativeId).includes(input.extension_id)) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension deletion was not confirmed; reconcile before retrying', { resourceIds: [input.extension_id] });
      return [input.extension_id];
    } };
    const value = target.parse((op.payload as Row).target), entity = await this.entity(op.accountId, value), linking = op.tool === 'microsoft_link_ad_extension';
    if (linking && guard.forcePausedCreation && !entity.paused) throw new AdportError('POLICY_VIOLATION', 'microsoft: extension associations cannot be paused; paused_creation requires a paused campaign or ad group target');
    return { summary: `${linking ? 'Associate' : 'Remove'} Microsoft extension ${input.extension_id} ${linking ? 'with' : 'from'} ${value.type} ${entity.entityId}`, changes: [`${linking ? '+' : '-'} explicit association; extension ${input.extension_id}; ${value.type} ${entity.entityId}`, 'Associations have no pause state. No campaign/ad group status is changed; other associations are preserved.'], coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(op.accountId, linking ? 'AdExtensionsAssociations/Set' : 'AdExtensionsAssociations', { AccountId: op.accountId, AdExtensionIdToEntityIdAssociations: [{ AdExtensionId: input.extension_id, EntityId: entity.entityId }], AssociationType: value.type }, linking ? 'POST' : 'DELETE');
      const readback = await this.associations({ account_id: op.accountId, target: value, extension_type: input.extension_type });
      const exists = readback.associations.some(value => nativeId(row(value.AdExtension).Id) === input.extension_id);
      if (exists !== linking) throw new AdportError('PROVIDER_ERROR', 'microsoft: extension association change was not confirmed; reconcile before retrying', { resourceIds: [input.extension_id] });
      return [input.extension_id];
    } };
  }

  private async confirm(account: string, extension: string, type: z.infer<typeof extensionType>, expected: Row, previousVersion?: number) {
    try {
      const actual = await this.getRaw(account, extension, type);
      if (previousVersion !== undefined && Number(actual.Version) <= previousVersion) throw new Error('Version did not advance');
      for (const key of Object.keys(expected).filter(key => !['Id', 'Type', 'ImageMediaIds', 'Images'].includes(key))) {
        if (JSON.stringify(actual[key] ?? null) !== JSON.stringify(expected[key] ?? null)) throw new Error(`Readback mismatch: ${key}`);
      }
      if (type === 'ImageAdExtension' && JSON.stringify(this.imageIds(actual).sort()) !== JSON.stringify(this.imageIds(expected).sort())) throw new Error('Image references were not confirmed');
    } catch { throw new AdportError('PROVIDER_ERROR', `microsoft: extension ${extension} mutation was accepted but content readback was not confirmed; reconcile before retrying`, { resourceIds: [extension] }); }
  }

  private async verifyImages(account: string, value: Row) {
    if (value.Type !== 'ImageAdExtension') return;
    const ids = this.imageIds(value);
    if (!ids.length || (await this.imageLookup(account, ids)).missing_image_ids.length) throw new AdportError('INVALID_INPUT', 'microsoft: image references could not be verified in the selected account library');
  }
}

export function microsoftExtensionTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_ad_extensions', namespace: 'microsoft', description: 'View account-owned callout, sitelink, structured-snippet and image extensions, including native versions and shared-content edit actions. Continue with next_cursor as after_extension_id.', input: z.object({ account_id: id, extension_types: z.array(extensionType).min(1).max(4).default([...extensionType.options]), after_extension_id: id.optional(), limit: z.number().int().positive().max(100).default(20) }), output: extensionOutput, presentation: 'creatives', pagination: { cursorInput: 'after_extension_id' }, annotations: { readOnly: true }, handler: input => provider.extensions.list(input) }),
    defineTool({ name: 'microsoft_get_ad_extension', namespace: 'microsoft', description: 'Read one extension by exact ID and type in the selected account, including the native version required for edits.', input: reference.extend({ account_id: id }), output: extensionOutput, presentation: 'creatives', annotations: { readOnly: true }, handler: input => provider.extensions.get(input) }),
    defineTool({ name: 'microsoft_ad_extension_associations', namespace: 'microsoft', description: 'Read direct extension associations for an account, campaign or verified ad group. Native editorial status is preserved; inherited associations are not combined.', input: z.object({ account_id: id, target, extension_type: extensionType }), output: z.object({ associations: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() }), annotations: { readOnly: true }, handler: input => provider.extensions.associations(input) }),
    guardedWriteTool({ name: 'microsoft_create_ad_extension', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Create an unattached callout, sitelink, structured-snippet or image extension. Native status is Active but no serving association is created. Uses full native content readback.', payload: z.object({ content }) }),
    guardedWriteTool({ name: 'microsoft_update_ad_extension', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Edit supplied shared extension content with expected_version. Preserves omitted mutable fields and scheduling; all associated entities can change. Image alt text here belongs to the extension, not the source media.', payload: update }),
    guardedWriteTool({ name: 'microsoft_delete_ad_extension', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Permanently delete an account-owned shared extension and its associations. Requires its latest native version. Source images remain in the account library.', payload: versioned }),
    guardedWriteTool({ name: 'microsoft_link_ad_extension', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Associate a version-verified extension with one owned entity. Associations cannot be paused; default paused_creation requires a paused parent campaign or ad group. Account-wide associations are blocked under that policy.', payload: versioned.extend({ target }) }),
    guardedWriteTool({ name: 'microsoft_unlink_ad_extension', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Remove one explicit extension association, preserving its source extension and other associations. Does not alter inherited associations or serving statuses.', payload: versioned.extend({ target }) }),
  ];
}

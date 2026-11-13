import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAssetPlan } from './assets.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
const id = z.string().regex(/^[1-9]\d*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(80);
const metadata = { name, background_color: z.string().regex(/^#(?:[a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/).optional(), description: z.string().max(200).optional() };
const create = z.object(metadata);
const selected = { label_id: id, expected_label_hash: hash };
const update = z.object({ ...selected, ...metadata, name: name.optional() }).refine(value => value.name !== undefined || value.background_color !== undefined || value.description !== undefined, 'Supply at least one label field');
const remove = z.object(selected);
const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CAMPAIGN'), campaign_id: id }),
  z.object({ type: z.literal('AD_GROUP'), campaign_id: id, ad_group_id: id }),
  z.object({ type: z.literal('AD_GROUP_AD'), campaign_id: id, ad_group_id: id, ad_id: id }),
  z.object({ type: z.literal('AD_GROUP_CRITERION'), campaign_id: id, ad_group_id: id, criterion_id: id }),
]);
const association = z.object({ ...selected, target });
type Target = z.infer<typeof target>;
const fields = 'label.resource_name, label.id, label.name, label.status, label.text_label.background_color, label.text_label.description';
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const config = {
  CAMPAIGN: { resource: 'campaign_label', key: 'campaignLabel', service: 'campaignLabels', entity: 'campaign', entityKey: 'campaign', entityService: 'campaigns', relation: 'campaign' },
  AD_GROUP: { resource: 'ad_group_label', key: 'adGroupLabel', service: 'adGroupLabels', entity: 'ad_group', entityKey: 'adGroup', entityService: 'adGroups', relation: 'adGroup' },
  AD_GROUP_AD: { resource: 'ad_group_ad_label', key: 'adGroupAdLabel', service: 'adGroupAdLabels', entity: 'ad_group_ad', entityKey: 'adGroupAd', entityService: 'adGroupAds', relation: 'adGroupAd' },
  AD_GROUP_CRITERION: { resource: 'ad_group_criterion_label', key: 'adGroupCriterionLabel', service: 'adGroupCriterionLabels', entity: 'ad_group_criterion', entityKey: 'adGroupCriterion', entityService: 'adGroupCriteria', relation: 'adGroupCriterion' },
} as const;
export const GOOGLE_LABEL_WRITES = new Set(['google_create_label', 'google_update_label', 'google_remove_label', 'google_link_label', 'google_unlink_label']);

/** Wire contracts: googleapis/googleapis@57aa4dbc, Google Ads v25. */
export class GoogleLabelService {
  constructor(private readonly client: GoogleAdsRestClient) {}

  private labelResource(account: string, labelId: string) { return `customers/${account}/labels/${labelId}`; }

  private validateLabel(account: string, value: unknown): Row {
    const row = record(value), text = record(row.textLabel);
    if (!id.safeParse(row.id).success || row.resourceName !== this.labelResource(account, String(row.id)) || row.status !== 'ENABLED' || !name.safeParse(row.name).success || !z.object({ backgroundColor: metadata.background_color, description: metadata.description }).safeParse(text).success) throw new AdportError('PROVIDER_ERROR', 'google: label response has an invalid identity, status or metadata');
    return row;
  }

  async list(input: { account_id: string; after_label_id?: string; limit: number }) {
    const account = normalizeCustomerId(input.account_id);
    if (input.after_label_id) id.parse(input.after_label_id);
    const result = await this.client.search(account, `SELECT ${fields} FROM label WHERE label.status != 'REMOVED'${input.after_label_id ? ` AND label.id > ${input.after_label_id}` : ''} ORDER BY label.id ASC LIMIT ${input.limit + 1}`, { maxRows: input.limit + 1 });
    const values = result.map(row => this.validateLabel(account, row.label));
    if (values.some((row, index) => BigInt(String(row.id)) <= BigInt(index ? String(values[index - 1]!.id) : input.after_label_id ?? '0'))) throw new AdportError('PROVIDER_ERROR', 'google: label pagination did not advance in native ID order');
    const labels = values.slice(0, input.limit), truncated = values.length > input.limit;
    return { labels, truncated, ...(truncated ? { next_cursor: String(labels.at(-1)!.id) } : {}) };
  }

  async get(accountId: string, labelId: string) {
    const account = normalizeCustomerId(accountId); id.parse(labelId);
    const result = await this.client.search(account, `SELECT ${fields} FROM label WHERE label.id = ${labelId} AND label.status != 'REMOVED' LIMIT 2`, { maxRows: 2 });
    if (result.length !== 1) throw new AdportError('INVALID_INPUT', 'google: label was not found in the selected account');
    const label = this.validateLabel(account, result[0]!.label);
    if (label.id !== labelId) throw new AdportError('PROVIDER_ERROR', 'google: requested label identity mismatch');
    const text = record(label.textLabel);
    const snapshot = { resourceName: label.resourceName, id: label.id, status: label.status, name: label.name, backgroundColor: text.backgroundColor ?? '', description: text.description ?? '' };
    return { label, snapshot_hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  }

  private async checkedLabel(account: string, input: z.infer<typeof remove>) {
    const current = await this.get(account, input.label_id);
    if (current.snapshot_hash !== input.expected_label_hash) throw new AdportError('INVALID_INPUT', 'google: label metadata changed; read google_label_context and request a fresh preview');
    return current.label;
  }

  private entityResource(account: string, value: Target) {
    const c = config[value.type];
    const entityId = value.type === 'CAMPAIGN' ? value.campaign_id : value.type === 'AD_GROUP' ? value.ad_group_id : value.type === 'AD_GROUP_AD' ? `${value.ad_group_id}~${value.ad_id}` : `${value.ad_group_id}~${value.criterion_id}`;
    return { c, entityId, resource: `customers/${account}/${c.entityService}/${entityId}` };
  }

  private async checkTarget(account: string, value: Target) {
    const { c, resource } = this.entityResource(account, value);
    const conditions = [`campaign.id = ${value.campaign_id}`];
    if (value.type !== 'CAMPAIGN') conditions.push(`ad_group.id = ${value.ad_group_id}`);
    if (value.type === 'AD_GROUP_AD') conditions.push(`ad_group_ad.ad.id = ${value.ad_id}`);
    if (value.type === 'AD_GROUP_CRITERION') conditions.push(`ad_group_criterion.criterion_id = ${value.criterion_id}`);
    const parents = value.type === 'CAMPAIGN' ? '' : `, campaign.id${value.type === 'AD_GROUP' ? '' : ', ad_group.id'}`;
    const result = await this.client.search(account, `SELECT ${c.entity}.resource_name, ${c.entity}.status${parents} FROM ${c.entity} WHERE ${conditions.join(' AND ')} LIMIT 2`, { maxRows: 2 });
    const row = result[0], entity = record(row?.[c.entityKey]);
    if (result.length !== 1 || entity.resourceName !== resource || !['ENABLED', 'PAUSED'].includes(String(entity.status)) || (value.type !== 'CAMPAIGN' && record(row?.campaign).id !== value.campaign_id) || ((value.type === 'AD_GROUP_AD' || value.type === 'AD_GROUP_CRITERION') && record(row?.adGroup).id !== value.ad_group_id)) throw new AdportError('INVALID_INPUT', 'google: label target was not found in the selected account and parent hierarchy');
  }

  private async links(account: string, value: Target, labelId: string | undefined, limit: number) {
    const { c, resource } = this.entityResource(account, value), nativeRelation = c.entity;
    const result = await this.client.search(account, `SELECT ${c.resource}.resource_name, ${c.resource}.label, ${c.resource}.${nativeRelation} FROM ${c.resource} WHERE ${c.resource}.${nativeRelation} = '${resource}'${labelId ? ` AND ${c.resource}.label = '${this.labelResource(account, labelId)}'` : ''} LIMIT ${limit}`, { maxRows: limit });
    const values = result.map(row => record(row[c.key]));
    if (new Set(values.map(row => row.resourceName)).size !== values.length || values.some(row => {
      const nativeLabel = typeof row.label === 'string' ? row.label.match(new RegExp(`^customers/${account}/labels/([1-9]\\d*)$`))?.[1] : undefined;
      return !nativeLabel || (labelId && nativeLabel !== labelId) || row[c.relation] !== resource || row.resourceName !== `customers/${account}/${c.service}/${this.entityResource(account, value).entityId}~${nativeLabel}`;
    })) throw new AdportError('PROVIDER_ERROR', 'google: label association identity mismatch');
    return values;
  }

  async listAssociations(input: { account_id: string; target: Target; limit: number }) {
    const account = normalizeCustomerId(input.account_id), value = target.parse(input.target);
    await this.checkTarget(account, value);
    const values = await this.links(account, value, undefined, input.limit + 1);
    return { associations: values.slice(0, input.limit), truncated: values.length > input.limit };
  }

  async plan(op: WriteOperation): Promise<GoogleAssetPlan> {
    const creating = op.tool === 'google_create_label' || op.tool === 'google_link_label', removing = op.tool === 'google_remove_label' || op.tool === 'google_unlink_label';
    if (op.provider !== 'google' || !GOOGLE_LABEL_WRITES.has(op.tool) || op.kind !== (creating ? 'create' : removing ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'google: label operation kind mismatch');
    const account = normalizeCustomerId(op.accountId);
    let service = 'labels', operation: Row, expectedResource: string | undefined, summary: string, changes: string[];
    const fieldChanges: NonNullable<GoogleAssetPlan['fieldChanges']> = [];
    if (op.tool === 'google_create_label') {
      const input = create.parse(op.payload), textLabel = { ...(input.background_color !== undefined ? { backgroundColor: input.background_color } : {}), ...(input.description !== undefined ? { description: input.description } : {}) };
      operation = { create: { name: input.name, ...(Object.keys(textLabel).length ? { textLabel } : {}) } };
      summary = `Create Google label “${input.name}”`; changes = [`+ ${JSON.stringify(operation.create)}`, 'Creates unattached classification metadata. Labels have no pause state; no serving association, campaign, ad or budget is changed.'];
      fieldChanges.push({ field: 'Label name', before: '(new)', after: input.name });
      if (input.background_color !== undefined) fieldChanges.push({ field: 'Background color', before: '(new)', after: input.background_color });
      if (input.description !== undefined) fieldChanges.push({ field: 'Description', before: '(new)', after: input.description });
    } else if (op.tool === 'google_update_label' || op.tool === 'google_remove_label') {
      const input = op.tool === 'google_update_label' ? update.parse(op.payload) : remove.parse(op.payload), current = await this.checkedLabel(account, input);
      expectedResource = this.labelResource(account, input.label_id);
      if (op.tool === 'google_remove_label') {
        operation = { remove: expectedResource }; summary = `Remove Google label “${current.name}”`;
        changes = [`- ${JSON.stringify(current)}`, 'Removes the label and its associations, including on active entities. Label-based reports and automation can change. Entity serving statuses and budgets are preserved. The snapshot covers metadata, not an atomic association inventory.'];
        fieldChanges.push({ field: 'Label', before: `${current.name} (${input.label_id})`, after: '(removed)' });
      } else {
        const value = update.parse(input), textLabel: Row = {}, mask: string[] = [], fields: Row = {};
        if (value.name !== undefined) { fields.name = value.name; mask.push('name'); }
        if (value.background_color !== undefined) { textLabel.backgroundColor = value.background_color; mask.push('text_label.background_color'); }
        if (value.description !== undefined) { textLabel.description = value.description; mask.push('text_label.description'); }
        operation = { update: { resourceName: expectedResource, ...fields, ...(Object.keys(textLabel).length ? { textLabel } : {}) }, updateMask: mask.join(',') };
        summary = `Update Google label “${current.name}”`; changes = [`~ ${JSON.stringify(current)} → supplied fields ${JSON.stringify(operation.update)}`, 'Only supplied metadata fields change; omitted color and description are preserved. Applies to every use of this shared label, including reports and automation.'];
        if (value.name !== undefined) fieldChanges.push({ field: 'Label name', before: String(current.name), after: value.name });
        if (value.background_color !== undefined) fieldChanges.push({ field: 'Background color', before: String(record(current.textLabel).backgroundColor ?? ''), after: value.background_color });
        if (value.description !== undefined) fieldChanges.push({ field: 'Description', before: String(record(current.textLabel).description ?? ''), after: value.description });
      }
    } else {
      const input = association.parse(op.payload), label = await this.checkedLabel(account, input);
      await this.checkTarget(account, input.target);
      const { c, resource, entityId } = this.entityResource(account, input.target), current = await this.links(account, input.target, input.label_id, 2);
      if (creating ? current.length !== 0 : current.length !== 1) throw new AdportError('INVALID_INPUT', creating ? 'google: label association already exists; do not replay creation' : 'google: label association was not found');
      service = c.service; expectedResource = `customers/${account}/${service}/${entityId}~${input.label_id}`;
      operation = removing ? { remove: expectedResource } : { create: { [c.relation]: resource, label: this.labelResource(account, input.label_id) } };
      summary = `${creating ? 'Assign' : 'Unassign'} Google label “${label.name}”`;
      changes = [`${creating ? '+' : '-'} ${expectedResource}`, 'Classification only, including on active entities; no pause field exists. Label-based reports and automation can change. Entity content, serving statuses and budgets are preserved.'];
      fieldChanges.push({ field: 'Target', before: resource, after: resource }, { field: 'Label assignment', before: creating ? '(unassigned)' : `${label.name} (${input.label_id})`, after: removing ? '(unassigned)' : `${label.name} (${input.label_id})` });
    }
    return { summary, changes, fieldChanges, notes: changes.slice(1), coercions: [], budgetDeltas: [], execute: async validateOnly => {
      const result = await this.client.mutate(account, service, [operation], { validateOnly });
      const resources = (result.results ?? []).flatMap(value => value.resourceName ? [value.resourceName] : []);
      if (!validateOnly && (resources.length !== 1 || (expectedResource ? resources[0] !== expectedResource : !new RegExp(`^customers/${account}/labels/[1-9]\\d*$`).test(resources[0]!)))) throw new AdportError('PROVIDER_ERROR', 'google: label mutation receipt mismatch; reconcile before retrying', { resource_ids: resources });
      return resources;
    } };
  }
}

export function googleLabelTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodObject, kind: 'create' | 'update' | 'remove') => guardedWriteTool({ name, namespace: 'google', provider: 'google', description, payload, kind });
  return [
    defineTool({ name: 'google_labels', namespace: 'google', description: 'Read enabled account-owned label metadata in native ID order. Continue next_cursor as after_label_id. Labels owned by managers are separate.', input: z.object({ account_id: z.string(), after_label_id: id.optional(), limit: z.number().int().positive().max(200).default(50) }), output: z.object({ labels: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), next_cursor: id.optional() }), annotations: { readOnly: true }, pagination: { cursorInput: 'after_label_id' }, handler: input => provider.labels.list(input) }),
    defineTool({ name: 'google_label_context', namespace: 'google', description: 'Read one enabled owned label and its metadata snapshot_hash. Supply that value as expected_label_hash for edits, removal or associations; association inventory is not included.', input: z.object({ account_id: z.string(), label_id: id }), output: z.object({ label: z.record(z.string(), z.unknown()), snapshot_hash: hash }), annotations: { readOnly: true }, handler: input => provider.labels.get(input.account_id, input.label_id) }),
    defineTool({ name: 'google_label_associations', namespace: 'google', description: 'Read label assignments for an owned campaign, ad group, ad or criterion after checking the full account/parent hierarchy. Reports truncation; manager-to-customer labels are separate.', input: z.object({ account_id: z.string(), target, limit: z.number().int().positive().max(200).default(100) }), output: z.object({ associations: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean() }), annotations: { readOnly: true }, handler: input => provider.labels.listAssociations(input) }),
    write('google_create_label', 'Create unattached label metadata with native validate_only preview. Name 1–80 characters; optional hex background color and description up to 200 characters. No serving or budget change.', create, 'create'),
    write('google_update_label', 'Edit supplied owned label metadata after matching google_label_context. Omitted fields are preserved; an empty description clears it. Changes every use of this shared label, including reports and automation.', update, 'update'),
    write('google_remove_label', 'Remove an owned label and its assignments after matching its metadata snapshot. Affects all uses, including active entities and label-based reports or automation. Does not delete labeled entities.', remove, 'remove'),
    write('google_link_label', 'Assign a current owned label to a verified campaign, ad group, ad or criterion. Classification can affect reports and automation; serving statuses and budgets are preserved. Rejects existing assignments.', association, 'create'),
    write('google_unlink_label', 'Remove one exact owned label assignment, preserving the shared label and labeled entity. Requires current label metadata hash. Native validate_only runs before approval.', association, 'remove'),
  ];
}

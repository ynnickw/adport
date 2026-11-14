import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsClient } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { accountUrn, linkedinId as id, NON_DISCRIMINATION_NOTICE, targetingSchema } from './schemas.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().trim().min(1).max(100), description = z.string().max(500);
const nativeId = z.union([id, z.number().int().positive().safe()]).transform(String);
const stamp = z.looseObject({ time: z.number().int().nonnegative().safe(), actor: z.string().optional() });
const template = z.looseObject({ id: nativeId, account: accountUrn, name: z.string(), description: z.string().optional(), targetingCriteria: targetingSchema, approximateMemberCount: z.number().int().nonnegative().safe().optional(), created: stamp.optional(), lastModified: stamp.optional() });
const paging = z.looseObject({ start: z.number().int().nonnegative().safe(), count: z.number().int().nonnegative().safe(), total: z.number().int().nonnegative().safe().optional(), links: z.array(z.looseObject({ rel: z.string() })).optional() });
const listInput = z.object({ account_id: id, start: z.number().int().nonnegative().safe().default(0), count: z.number().int().min(1).max(100).default(50), sort_field: z.enum(['ID', 'NAME']).default('ID'), sort_order: z.enum(['ASCENDING', 'DESCENDING']).default('ASCENDING') }).strict();
const criteria = targetingSchema.refine(value => value.include.and.every(clause => Object.keys(clause.or).length > 0) && (!value.exclude || Object.keys(value.exclude.or).length > 0), 'Use nonempty targeting clauses');
const createInput = z.object({ expected_account_hash: hash, name, description: description.optional(), targeting_criteria: criteria }).strict();
const reference = { template_id: id, expected_snapshot_hash: hash };
const updateInput = z.object({ ...reference, name: name.optional(), description: description.optional(), targeting_criteria: criteria.optional() }).strict().refine(value => value.name !== undefined || value.description !== undefined || value.targeting_criteria !== undefined, 'Supply an editable template field');
const deleteInput = z.object(reference).strict();
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
const snapshot = (value: z.infer<typeof template>) => digest({ id: value.id, account: value.account, name: value.name, description: value.description ?? null, targetingCriteria: value.targetingCriteria, modified: value.lastModified?.time ?? null });
const writes = new Set(['linkedin_create_saved_audience', 'linkedin_update_saved_audience', 'linkedin_delete_saved_audience']);

/** LinkedIn Marketing202608 adTargetTemplates and Rest.li paging contracts checked2026-11-04. */
export class LinkedInAudienceService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  supports(tool: string) { return writes.has(tool); }
  private async account(account: string) {
    const value = await this.provider.getAccount(id.parse(account));
    return { account_id: account, account_snapshot_hash: digest({ id: value.id, currency: value.currency, status: value.status }), account: value };
  }
  private owned(account: string, value: z.infer<typeof template>, selected?: string) {
    if (value.account !== `urn:li:sponsoredAccount:${account}` || selected !== undefined && value.id !== selected) throw new AdportError('PROVIDER_ERROR', 'linkedin: saved-audience advertiser/ID mismatch');
    return { ...value, snapshot_hash: snapshot(value) };
  }
  async list(raw: z.input<typeof listInput>) {
    const input = listInput.parse(raw), context = await this.account(input.account_id);
    const result = await this.client.get('adTargetTemplates', z.looseObject({ elements: z.array(template), paging: paging.optional() }), { q: 'account', account: `urn:li:sponsoredAccount:${input.account_id}`, sortField: input.sort_field, sortOrder: input.sort_order, start: input.start, count: input.count });
    if (result.elements.length > input.count || result.paging && (result.paging.start !== input.start || result.paging.count > input.count || result.paging.count < result.elements.length) || !result.paging && input.start > 0 || new Set(result.elements.map(row => row.id)).size !== result.elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: saved-audience pagination returned an inconsistent offset, size or duplicate identity');
    const next = Boolean(result.paging?.links?.some(link => link.rel === 'next')) || (result.paging?.total !== undefined ? input.start + result.elements.length < result.paging.total : result.elements.length === input.count);
    if (next && !result.elements.length || result.paging?.total !== undefined && result.elements.length && input.start + result.elements.length > result.paging.total) throw new AdportError('PROVIDER_ERROR', 'linkedin: saved-audience pagination did not advance or contradicted its total');
    const complete = result.paging ? input.start === 0 && !next : null;
    return { ...context, ...result, elements: result.elements.map(row => this.owned(input.account_id, row)), truncated: next, complete, ...(next && result.paging ? { next_start: input.start + input.count } : {}), notes: [NON_DISCRIMINATION_NOTICE, 'Saved templates are targeting definitions. Applying criteria to a campaign uses its separate guarded update.', ...(!result.paging ? ['The native response omitted paging metadata; collection completeness is unknown and no continuation is invented.'] : [])] };
  }
  async get(account: string, templateId: string) {
    const context = await this.account(account), value = await this.client.get(`adTargetTemplates/${id.parse(templateId)}`, template);
    return { ...context, template: this.owned(account, value, templateId) };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'linkedin_create_saved_audience', remove = op.tool === 'linkedin_delete_saved_audience';
    if (op.provider !== 'linkedin' || !writes.has(op.tool) || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: saved-audience operation kind mismatch');
    const notes = [NON_DISCRIMINATION_NOTICE, 'Local preview only. This operation writes a saved targeting template, not a campaign, bid, budget or delivery setting.', 'Native writes are not idempotent. Uncertain failures consume approval; reconcile the template ID/list before a new preview. No automatic write retry.'];
    if (create) {
      const input = createInput.parse(op.payload), context = await this.account(op.accountId);
      if (input.expected_account_hash !== context.account_snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: advertiser settings changed; read saved audiences again before a new preview');
      const fields = { account: `urn:li:sponsoredAccount:${op.accountId}`, name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), targetingCriteria: input.targeting_criteria };
      return { summary: `Create LinkedIn saved audience "${input.name}"`, changes: [`+ ${JSON.stringify(fields)}`], notes, coercions: [], budgetDeltas: [], execute: async () => {
        const resource = await this.client.create('adTargetTemplates', fields);
        try { const current = await this.get(op.accountId, resource); if (!this.matches(current.template, fields)) throw new Error('settings mismatch'); }
        catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: saved-audience creation readback unconfirmed; inspect the returned ID before any new create', { resource_ids: [resource] }); }
        return { applied: true, resourceIds: [resource] };
      } };
    }
    const input = remove ? deleteInput.parse(op.payload) : updateInput.parse(op.payload), current = await this.get(op.accountId, input.template_id);
    if (input.expected_snapshot_hash !== current.template.snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: saved audience changed; read its current snapshot before requesting another preview');
    if (remove) return { summary: `Permanently delete LinkedIn saved audience "${current.template.name}"`, changes: [`- Saved audience template ${input.template_id}. Native deletion has no restore endpoint.`], notes, coercions: [], budgetDeltas: [], execute: async () => { await this.client.remove(`adTargetTemplates/${input.template_id}`); return { applied: true, resourceIds: [input.template_id], details: { deletion: 'DELETED' } }; } };
    const update = updateInput.parse(input), fields = { ...(update.name !== undefined ? { name: update.name } : {}), ...(update.description !== undefined ? { description: update.description } : {}), ...(update.targeting_criteria !== undefined ? { targetingCriteria: update.targeting_criteria } : {}) };
    if (this.matches(current.template, fields)) throw new AdportError('INVALID_INPUT', 'linkedin: saved-audience fields already match; no change to apply');
    const labels: Record<string, string> = { name: 'Name', description: 'Description', targetingCriteria: 'Targeting criteria' };
    const observed: Record<string, unknown> = current.template;
    return { summary: `Update LinkedIn saved audience "${current.template.name}"`, changes: [`~ Saved template fields ${JSON.stringify(fields)}. Supplied targeting criteria replaces the full definition; omitted fields are preserved.`], review: { provider: 'linkedin', accountId: op.accountId, kind: 'update', title: 'Update saved audience', subject: current.template.name, fields: Object.entries(fields).map(([field, after]) => ({ label: labels[field]!, ...(Object.hasOwn(observed, field) ? { before: observed[field] } : {}), after })), notices: notes }, notes, coercions: [], budgetDeltas: [], execute: async () => {
      await this.client.update(`adTargetTemplates/${input.template_id}`, fields);
      try { if (!this.matches((await this.get(op.accountId, input.template_id)).template, fields)) throw new Error('settings mismatch'); }
      catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: saved-audience update readback unconfirmed; reconcile before a new preview', { resource_ids: [input.template_id] }); }
      return { applied: true, resourceIds: [input.template_id] };
    } };
  }
  private matches(actual: Record<string, unknown>, expected: Record<string, unknown>) { return Object.entries(expected).every(([key, value]) => digest(actual[key]) === digest(value)); }
}

export function linkedinAudienceTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_saved_audiences', namespace: 'linkedin', description: 'List advertiser-owned saved audience templates with native account finder, sort and offset paging. Returns account_snapshot_hash for creation and per-template snapshots. Missing paging metadata means unknown completeness.', input: listInput, annotations: { readOnly: true }, handler: input => provider.audiences.list(input) }),
    defineTool({ name: 'linkedin_get_saved_audience', namespace: 'linkedin', description: 'Read one saved audience template, verify advertiser/ID and return its current snapshot_hash for guarded edits/deletion.', input: z.object({ account_id: id, template_id: id }), annotations: { readOnly: true }, handler: input => provider.audiences.get(input.account_id, input.template_id) }),
    guardedWriteTool({ name: 'linkedin_create_saved_audience', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, description: 'Create a saved targeting template using expected_account_hash from linkedin_saved_audiences. Native name≤100/description≤500. Does not send a campaign update; no automatic retry. Creation is independently read back.', payload: createInput }),
    guardedWriteTool({ name: 'linkedin_update_saved_audience', namespace: 'linkedin', provider: 'linkedin', kind: 'update', description: 'Update supplied saved-template name, description or complete targeting_criteria using expected_snapshot_hash. Omitted fields stay unchanged; empty description clears text. Verifies native readback; no campaign update or automatic retry.', payload: updateInput }),
    guardedWriteTool({ name: 'linkedin_delete_saved_audience', namespace: 'linkedin', provider: 'linkedin', kind: 'remove', description: 'Permanently delete one advertiser-owned saved targeting template using expected_snapshot_hash. Native204 confirms deletion; no restore endpoint or automatic retry.', payload: deleteInput }),
  ];
}

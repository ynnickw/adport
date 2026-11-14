import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { audienceGet, audienceList, audiencePermissions, audienceUsers, createAudience, deleteAudience, updateAudience } from './audience-tools.js';
import type { XParams } from './client.js';
import type { XAdsEntities } from './entities.js';
import { lineItemSchema, xId as id } from './schemas.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const audience = z.looseObject({ id, name: z.string(), description: z.string().nullable(), audience_type: z.string(), deleted: z.boolean(), permission_level: z.string(), owner_account_id: id.optional(), is_owner: z.boolean().optional(), targetable: z.boolean().optional(), audience_size: z.number().int().nonnegative().safe().nullable().optional(), partner_source: z.string().optional() });
type Audience = z.infer<typeof audience>;
const permission = z.looseObject({ id, custom_audience_id: id, granted_account_id: id, permission_level: z.string(), deleted: z.boolean() });
const target = z.looseObject({ campaign_id: id, campaign_name: z.string().nullable().optional(), line_items: z.array(z.looseObject({ id, name: z.string().nullable().optional(), servable: z.boolean() })) });
const criterion = z.looseObject({ id, line_item_id: id, targeting_type: z.string(), targeting_value: z.string(), operator_type: z.string().optional(), deleted: z.boolean() });
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const configuration = (value: Audience) => Object.fromEntries(['id', 'name', 'description', 'audience_type', 'permission_level', 'owner_account_id', 'is_owner', 'partner_source', 'deleted'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const snapshot = (account: string, value: Audience) => digest({ account_id: account, configuration: configuration(value) });
const notes = ['Local preview only; X has no server dry run or conditional configuration update for this workflow.', 'No automatic write retry. Reconcile known IDs and receipts after an uncertain result.'];
const rejection = (error: unknown) => error instanceof AdportError && error.details !== null && typeof error.details === 'object' && 'http_status' in error.details && [401, 403, 429].includes(Number(error.details.http_status));

/** X-owned v12 audience reference at 4e8f626, inspected 2026-11-05. */
export class XAudienceService {
  constructor(private readonly entities: XAdsEntities) {}
  private base(account: string) { return `accounts/${id.parse(account)}/custom_audiences`; }
  private scope(value: { request?: { params?: Row } }, account: string, resource?: string) {
    const params = value.request?.params;
    if (params && (params.account_id !== undefined && params.account_id !== account || resource && params.custom_audience_id !== undefined && params.custom_audience_id !== resource)) throw new AdportError('PROVIDER_ERROR', 'x: audience response scope differs from the selected account/ID');
  }
  private owned(value: Audience, account: string) {
    if (value.owner_account_id !== undefined && value.owner_account_id !== account || value.is_owner === false || value.owner_account_id === undefined && value.is_owner !== true || value.permission_level !== 'READ_WRITE') throw new AdportError('INVALID_INPUT', 'x: audience must be verifiably owned and writable by the selected account');
    if (value.deleted) throw new AdportError('INVALID_INPUT', 'x: deleted audiences cannot be modified');
  }
  private async page<S extends z.ZodType>(account: string, path: string, schema: S, params: XParams, resource?: string) {
    const data = await this.entities.client.request('GET', path, z.looseObject({ data: z.array(schema), next_cursor: z.string().nullable().optional(), total_count: z.number().int().nonnegative().safe().optional(), request: z.object({ params: z.record(z.string(), z.unknown()).optional() }).optional() }), params);
    this.scope(data, account, resource);
    if (data.next_cursor && data.next_cursor === params.cursor) throw new AdportError('PROVIDER_ERROR', 'x: audience pagination repeated its cursor');
    const identities = data.data.map(value => String((value as Row).id ?? (value as Row).campaign_id));
    if (new Set(identities).size !== identities.length || data.data.length > 1000) throw new AdportError('PROVIDER_ERROR', 'x: audience page exceeds its native limit or repeats entities');
    const complete = data.next_cursor === null ? true : data.next_cursor ? false : null;
    if (!params.cursor && data.total_count !== undefined && (data.total_count < data.data.length || complete && data.total_count !== data.data.length)) throw new AdportError('PROVIDER_ERROR', 'x: audience total count contradicts the native page');
    return { ...data, complete, truncated: complete !== true, next_cursor: data.next_cursor || undefined };
  }
  private pageParams(input: { cursor?: string; with_total_count: boolean } & Row): XParams {
    const params = Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== 'with_total_count' && value !== undefined)) as XParams;
    if (input.with_total_count && !input.cursor) params.with_total_count = true;
    return params;
  }
  private record(value: Audience): Row {
    return { id: value.id, name: value.name, status: value.deleted ? 'Deleted' : value.targetable === true ? 'Targetable' : value.targetable === false ? 'Not targetable' : 'Targetability not reported',
      audience_type: value.audience_type, audience_size: value.audience_size ?? 'Not reported',
      ...(Array.isArray(value.reasons_not_targetable) && value.reasons_not_targetable.length ? { reasons_not_targetable: value.reasons_not_targetable } : {}),
      permission_level: value.permission_level,
    };
  }
  async list(raw: z.input<typeof audienceList>) {
    const { account_id, custom_audience_ids, ...input } = audienceList.parse(raw);
    await this.entities.getAccount(account_id);
    const params = this.pageParams(input);
    if (custom_audience_ids) params.custom_audience_ids = custom_audience_ids.join(',');
    const page = await this.page(account_id, this.base(account_id), audience, params);
    if (page.data.some(value => custom_audience_ids && !custom_audience_ids.includes(value.id) || !input.with_deleted && value.deleted || input.q && !value.name.toLowerCase().startsWith(input.q.toLowerCase()) || input.permission_scope === 'OWNER' && (value.owner_account_id !== undefined && value.owner_account_id !== account_id || value.is_owner === false) || input.permission_scope === 'SHARED' && (value.owner_account_id === account_id || value.is_owner === true))) throw new AdportError('PROVIDER_ERROR', 'x: audience list does not match its ID/deletion/ownership/name filters');
    const items = page.data.map(value => ({ ...value, configuration_hash: snapshot(account_id, value) }));
    return { ...page, data: items, records: items.map(value => this.record(value)), notes: [...(page.complete === null ? ['Native next_cursor is missing; completeness is unconfirmed.'] : []), ...(page.data.length > input.count ? ['The native endpoint exceeded the requested count; the full page is retained.'] : [])] };
  }
  async get(raw: z.input<typeof audienceGet>) {
    const input = audienceGet.parse(raw);await this.entities.getAccount(input.account_id);
    const response = await this.entities.client.request('GET', `${this.base(input.account_id)}/${input.custom_audience_id}`, z.looseObject({ data: audience, request: z.object({ params: z.record(z.string(), z.unknown()).optional() }).optional() }), { with_deleted: input.with_deleted });
    this.scope(response, input.account_id, input.custom_audience_id);
    if (response.data.id !== input.custom_audience_id || !input.with_deleted && response.data.deleted) throw new AdportError('PROVIDER_ERROR', 'x: audience ID/deletion filter mismatch');
    const value = { ...response.data, configuration_hash: snapshot(input.account_id, response.data) };
    return { audience: value, records: [this.record(value)] };
  }
  async permissions(raw: z.input<typeof audiencePermissions>) {
    const { account_id, custom_audience_id, granted_account_ids, custom_audience_permission_ids, ...input } = audiencePermissions.parse(raw);
    await this.get({ account_id, custom_audience_id });
    const params = this.pageParams(input);
    if (granted_account_ids) params.granted_account_ids = granted_account_ids.join(',');
    if (custom_audience_permission_ids) params.custom_audience_permission_ids = custom_audience_permission_ids.join(',');
    const page = await this.page(account_id, `${this.base(account_id)}/${custom_audience_id}/permissions`, permission, params, custom_audience_id);
    if (page.data.some(value => value.custom_audience_id !== custom_audience_id || granted_account_ids && !granted_account_ids.includes(value.granted_account_id) || custom_audience_permission_ids && !custom_audience_permission_ids.includes(value.id))) throw new AdportError('PROVIDER_ERROR', 'x: audience permission ID/filter mismatch');
    return { ...page, records: page.data };
  }
  private async collect<S extends z.ZodType>(account: string, resource: string, path: string, schema: S, params: XParams = {}) {
    const rows: z.infer<S>[] = [], seen = new Set<string>(), ids = new Set<string>();let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 25; pageIndex++) {
      const page = await this.page(account, path, schema, { ...params, ...(cursor ? { cursor } : {}) }, resource);
      for (const value of page.data) {
        const identity = String((value as Row).id ?? (value as Row).campaign_id);
        if (ids.has(identity)) throw new AdportError('PROVIDER_ERROR', 'x: audience usage scan repeated an entity');ids.add(identity);rows.push(value);
      }
      if (rows.length > 5000 || page.complete === null) throw new AdportError('PROVIDER_ERROR', 'x: audience usage completeness could not be verified within the 5000-record limit');
      if (page.complete) return rows;
      if (seen.has(page.next_cursor!)) break;
      seen.add(page.next_cursor!);cursor = page.next_cursor;
    }
    throw new AdportError('PROVIDER_ERROR', 'x: audience usage paging is repeated or exceeds the 25-page limit');
  }
  async usage(account: string, resource: string) {
    const current = (await this.get({ account_id: account, custom_audience_id: resource })).audience, base = `${this.base(account)}/${id.parse(resource)}`;
    const targeted = await this.collect(account, resource, `${base}/targeted`, target, { with_active: false });
    const permissions = await this.collect(account, resource, `${base}/permissions`, permission, { count: 1000 });
    if (permissions.some(value => value.custom_audience_id !== resource)) throw new AdportError('PROVIDER_ERROR', 'x: usage returned another audience permission');
    const lines = await this.collect(account, resource, `accounts/${account}/line_items`, lineItemSchema, { with_deleted: true, with_draft: true, count: 1000 });
    const byLine = new Map(lines.map(value => [value.id, value]));
    if (targeted.some(campaign => campaign.line_items.some(line => byLine.get(line.id)?.campaign_id !== campaign.campaign_id))) throw new AdportError('PROVIDER_ERROR', 'x: targeted audience groups do not match the selected account hierarchy');
    const criteria: z.infer<typeof criterion>[] = [];
    let scannedCriteria = 0;
    for (let offset = 0; offset < lines.length; offset += 200) {
      const batch = lines.slice(offset, offset + 200), selected = new Set(batch.map(value => value.id));
      const values = await this.collect(account, resource, `accounts/${account}/targeting_criteria`, criterion, { line_item_ids: batch.map(value => value.id).join(','), with_deleted: false, count: 1000 });
      scannedCriteria += values.length;
      if (scannedCriteria > 5000) throw new AdportError('PROVIDER_ERROR', 'x: audience usage exceeds the 5000-criterion scan limit');
      if (values.some(value => !selected.has(value.line_item_id) || value.deleted)) throw new AdportError('PROVIDER_ERROR', 'x: usage criteria returned a different line item or deleted criterion');
      criteria.push(...values.filter(value => /AUDIENCE/.test(value.targeting_type) && value.targeting_value === resource));
    }
    const activePermissions = permissions.filter(value => !value.deleted), references = targeted.flatMap(value => value.line_items.map(line => ({ campaign_id: value.campaign_id, ...line })));
    const normalized = { account_id: account, audience_id: resource, references: references.map(value => ({ campaign_id: value.campaign_id, id: value.id, servable: value.servable })).sort((a, b) => canonical(a).localeCompare(canonical(b))), criteria: criteria.map(value => ({ id: value.id, line_item_id: value.line_item_id, targeting_type: value.targeting_type, targeting_value: value.targeting_value, operator_type: value.operator_type })).sort((a, b) => a.id.localeCompare(b.id)), permissions: activePermissions.map(value => ({ id: value.id, granted_account_id: value.granted_account_id, permission_level: value.permission_level })).sort((a, b) => a.id.localeCompare(b.id)) };
    const latest = (await this.get({ account_id: account, custom_audience_id: resource })).audience;
    if (latest.configuration_hash !== current.configuration_hash) throw new AdportError('INVALID_INPUT', 'x: audience configuration changed during usage inspection; read it again');
    return { audience: current, references, criteria, permissions: activePermissions, complete: true, usage_hash: digest(normalized), records: [{ id: resource, name: current.name, targeted_groups: references.length, direct_criteria: criteria.length, sharing_grants: activePermissions.length }], notes: ['Includes inactive targeting and direct inclusion/exclusion criteria. Native checks are not an atomic lock against changes in another client.'] };
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'x_create_custom_audience', remove = op.tool === 'x_delete_custom_audience', members = op.tool === 'x_update_custom_audience_users';
    if (op.provider !== 'x' || op.kind !== (create ? 'create' : remove ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: audience provider/operation kind mismatch');
    const account = id.parse(op.accountId), base = this.base(account);
    await this.entities.getAccount(account);
    if (create) {
      const input = createAudience.parse(op.payload);
      return { summary: `Create empty X audience "${input.name}"`, changes: [`+ CRM placeholder ${JSON.stringify(input)}`], notes: [...notes, 'No members are uploaded and no targeting or sharing is added.'], coercions: [], budgetDeltas: [], execute: async () => {
        let resource: string | undefined;
        try {
          const receipt = await this.entities.client.request('POST', base, z.object({ data: z.looseObject({ id }) }), input);resource = receipt.data.id;
          const actual = (await this.get({ account_id: account, custom_audience_id: resource })).audience;this.owned(actual, account);
          if (actual.name !== input.name || actual.description !== (input.description ?? null) || actual.audience_type !== 'CRM' || actual.targetable === true || (actual.audience_size ?? 0) > 0) throw new Error('Metadata or empty-placeholder state differs');
          return { applied: true, resourceIds: [resource] };
        } catch (error) {
          if (!resource && rejection(error)) throw error;
          throw new AdportError('PROVIDER_ERROR', 'x: audience creation outcome unconfirmed; reconcile the owned inventory before another create', { ...(resource ? { resource_ids: [resource] } : {}) });
        }
      } };
    }
    const input = remove ? deleteAudience.parse(op.payload) : members ? audienceUsers.parse(op.payload) : op.tool === 'x_update_custom_audience' ? updateAudience.parse(op.payload) : undefined;
    if (!input) throw new AdportError('INVALID_INPUT', 'x: unsupported audience mutation');
    const current = (await this.get({ account_id: account, custom_audience_id: input.custom_audience_id })).audience;this.owned(current, account);
    if (current.configuration_hash !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'x: audience configuration changed; read and preview it again');
    const path = `${base}/${current.id}`;
    if ('operations' in input) {
      if (current.audience_type !== 'CRM') throw new AdportError('INVALID_INPUT', 'x: native member updates require an owned CRM audience');
      for (const value of input.operations) if (value.params.expires_at && Date.parse(value.params.expires_at) <= (value.params.effective_at ? Date.parse(value.params.effective_at) : Date.now())) throw new AdportError('INVALID_INPUT', 'x: member expiry must follow its effective time');
      const count = input.operations.reduce((sum, value) => sum + value.params.users.length, 0), batchHash = digest(input.operations);
      const descriptions = input.operations.map(value => `${value.params.users.length} user ${value.params.users.length === 1 ? 'record' : 'records'}${value.params.effective_at ? `; effective ${value.params.effective_at}` : ''}${value.params.expires_at ? `; expiry ${value.params.expires_at}` : ''}`), changes = input.operations.map((value, index) => `${value.operation_type}: ${descriptions[index]}`);
      const uploadNotes = [...notes, 'Existing ads that use this audience can be affected. Native processing acceptance does not confirm audience readiness or exact membership. Native processing generally takes 6–8 hours.'];
      return { summary: `Submit member changes for X audience "${current.name}"`, changes: [...changes, `SHA256 ${batchHash}`], notes: uploadNotes, coercions: [], budgetDeltas: [],
        review: { provider: 'x', accountId: account, kind: op.kind, title: 'Submit audience members', subject: current.name, fields: [...input.operations.map((value, index) => ({ label: value.operation_type, after: descriptions[index]! })), { label: 'Batch SHA256', after: batchHash }], notices: uploadNotes }, execute: async () => {
        try {
          const receipt = await this.entities.client.request('POST', `${path}/users`, z.object({ data: z.object({ success_count: z.number().int().nonnegative().safe(), total_count: z.number().int().nonnegative().safe() }) }), {}, input.operations);
          if (receipt.data.success_count !== count || receipt.data.total_count !== count) throw new Error('Counts differ');
          return { applied: true, resourceIds: [current.id], details: { outcome: 'ACCEPTED_FOR_PROCESSING', accepted_records: count, batch_sha256: batchHash, readiness_confirmed: false }, warnings: ['Native audience processing and targeting readiness remain unconfirmed.'] };
        } catch (error) {
          if (rejection(error)) throw error;
          throw new AdportError('PROVIDER_ERROR', 'x: audience member submission outcome unconfirmed; do not replay the batch automatically', { resource_ids: [current.id], batch_sha256: batchHash, expected_records: count });
        }
      } };
    }
    if ('expected_usage_hash' in input) {
      const usage = await this.usage(account, current.id);
      if (usage.audience.configuration_hash !== input.expected_configuration_hash) throw new AdportError('INVALID_INPUT', 'x: audience configuration changed during deletion preflight');
      if (usage.usage_hash !== input.expected_usage_hash) throw new AdportError('INVALID_INPUT', 'x: audience usage changed; inspect it before another preview');
      if (usage.references.length || usage.criteria.length || usage.permissions.length) throw new AdportError('INVALID_INPUT', 'x: remove audience targeting, exclusions and sharing permissions before deletion');
    }
    const params = remove ? {} : Object.fromEntries(Object.entries(input).filter(([key, value]) => ['name', 'description'].includes(key) && value !== undefined)) as XParams;
    const expected = { ...configuration(current), ...params, ...(remove ? { deleted: true } : {}) };
    return { summary: `${remove ? 'Delete' : 'Update'} X audience "${current.name}"`, changes: [remove ? `- Audience ${current.id}` : `~ Metadata ${JSON.stringify(params)}`], notes, coercions: [], budgetDeltas: [],
      ...(!remove ? { review: { provider: 'x', accountId: account, kind: op.kind, title: 'Update audience', subject: current.name, fields: Object.entries(params).map(([key, value]) => ({ label: key === 'name' ? 'Name' : 'Description', before: key === 'name' ? current.name : current.description, after: value })), notices: notes } } : {}),
      execute: async () => {
        let accepted = false;
        try {
          const receipt = await this.entities.client.request(remove ? 'DELETE' : 'PUT', path, z.object({ data: z.looseObject({ id }) }), params);
          accepted = true;
          if (receipt.data.id !== current.id) throw new Error('ID differs');
          const actual = (await this.get({ account_id: account, custom_audience_id: current.id, with_deleted: remove })).audience;
          if (canonical(configuration(actual)) !== canonical(expected)) throw new Error('Metadata differs');
          return { applied: true, resourceIds: [current.id] };
        } catch (error) {
          if (!accepted && rejection(error)) throw error;
          throw new AdportError('PROVIDER_ERROR', `x: audience ${remove ? 'deletion' : 'update'} outcome unconfirmed; reconcile this ID before another mutation`, { resource_ids: [current.id] });
        }
      },
    };
  }
}

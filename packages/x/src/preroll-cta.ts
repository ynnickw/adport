import { createHash } from 'node:crypto';
import { AdportError, type Creative, type CreativeAction, type ReviewField, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { XAdsEntities } from './entities.js';
import type { XPostService } from './posts.js';
import { createPrerollCta, deletePrerollCta, nativePrerollCta, prerollCtaLabels, prerollCtaList, prerollCtaSelection, prerollCtaValues, updatePrerollCta } from './preroll-cta-schemas.js';
import { xId } from './schemas.js';

type Cta = z.infer<typeof nativePrerollCta>;
type Parent = Awaited<ReturnType<XPostService['parents']>>['snapshot'];
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const pageSchema = z.object({ data: z.array(nativePrerollCta).max(1000), next_cursor: z.string().nullable().optional() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (left: unknown, right: unknown) => hash(left) === hash(right);
const config = (row: Cta) => ({ id: row.id, line_item_id: row.line_item_id, call_to_action: row.call_to_action, call_to_action_url: row.call_to_action_url, deleted: row.deleted });
const configs = (rows: Cta[]) => rows.map(config).sort((a, b) => a.id.localeCompare(b.id));
const label = (value: string) => prerollCtaLabels[value as keyof typeof prerollCtaLabels] ?? value;
const safeDestination = (value: string) => { try { const url = new URL(value);return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined; } catch { return undefined; } };
const notices = ['CTA settings belong to the ad group and can affect all of its current and future preroll ads, not just one media association. Associated ads are not enumerated or frozen by this snapshot.', 'CTA presence is not proof of ad delivery or native placement rendering. Parent status, budgets, bids, media and ad associations are preserved.', 'Local preview is not native validation. Snapshots do not atomically lock native concurrent changes; no mutation is automatically retried.'];

/** Official X v12 preroll CTA GET/POST/PUT/DELETE contract refreshed2026-11-06. */
export class XPrerollCtaService {
  constructor(private readonly entities: XAdsEntities, private readonly posts: XPostService) {}
  private base(account: string) { return `accounts/${xId.parse(account)}/preroll_call_to_actions`; }
  private scope(account: string, row: Cta, id?: string, line?: string) {
    if (row.account_id !== undefined && row.account_id !== account || id !== undefined && row.id !== id || line !== undefined && row.line_item_id !== line) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA account/resource/ad-group mismatch');
    return row;
  }
  private paging(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || next && next === previous) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA pagination repeated an ID or cursor');
    return { truncated: next !== null, ...(next ? { next_cursor: next } : {}), ...(next === undefined || next === '' ? { notes: ['Native continuation marker is missing; completeness is unconfirmed.'] } : {}) };
  }
  private async page(account: string, line: string | undefined, count: number, withDeleted: boolean, cursor?: string) {
    const result = await this.entities.client.request('GET', this.base(account), pageSchema, { ...(line ? { line_item_ids: line } : {}), count, with_deleted: withDeleted, ...(cursor ? { cursor } : {}) });
    if (result.data.length > count) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA page exceeds its requested bound');
    for (const row of result.data) { this.scope(account, row, undefined, line);if (!withDeleted && row.deleted) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA deletion filter mismatch'); }
    this.paging(result.data.map(row => row.id), result.next_cursor, cursor);return result;
  }
  private async inventory(account: string, line: string) {
    const rows: Cta[] = [], ids = new Set<string>(), cursors = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.page(account, line, 200, false, cursor);
      for (const row of result.data) { if (ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA inventory repeated an ID');ids.add(row.id);rows.push(row); }
      if (result.next_cursor === null) return configs(rows);
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA inventory is incomplete; no mutation submitted');
  }
  private contextHash(account: string, row: Cta, parent: Parent, active: Cta[]) { return hash({ account_id: account, cta: config(row), parent, active_ctas: configs(active) }); }
  private card(account: string, row: Cta, parent?: Parent, contextHash?: string): Creative {
    const options = prerollCtaValues.map(value => ({ value, label: prerollCtaLabels[value] }));
    const fields: CreativeAction['fields'] = [...(prerollCtaValues.includes(row.call_to_action as typeof prerollCtaValues[number]) ? [{ key: 'call_to_action', label: 'Button', type: 'select' as const, value: row.call_to_action, options }] : []), { key: 'call_to_action_url', label: 'Destination', type: 'text', value: row.call_to_action_url, max_length: 4096 }];
    const args = { account_id: account, preroll_call_to_action_id: row.id, expected_context_hash: contextHash, acknowledge_ad_group_scope: true };
    const destination = safeDestination(row.call_to_action_url);
    const actions: Creative['actions'] = row.deleted || !parent || !contextHash ? [] : [...(this.canAuthor(parent) ? [{ label: 'Edit CTA', tool: 'x_update_preroll_cta', arguments: args, fields }] : []), { label: 'Remove CTA', tool: 'x_delete_preroll_cta', arguments: args, fields: [] }];
    return { id: row.id, provider: 'x', account_id: account, ...(parent ? { campaign_id: parent.campaign.id } : {}), ad_group_id: row.line_item_id, name: `Preroll CTA ${row.id}`, type: 'PREROLL_CTA', status: row.deleted ? 'DELETED' : 'PRESENT', headlines: [label(row.call_to_action)], descriptions: [], landing_urls: destination ? [destination] : [], media: [], actions };
  }
  private canAuthor(parent: Parent) { return !parent.line.deleted && !parent.campaign.deleted && ['ACTIVE', 'PAUSED'].includes(String(parent.line.entity_status)) && ['ACTIVE', 'PAUSED'].includes(parent.campaign.entity_status) && parent.line.objective === 'PREROLL_VIEWS'; }
  private eligible(parent: Parent) {
    if (!this.canAuthor(parent)) throw new AdportError('INVALID_INPUT', 'x: preroll CTA authoring needs an existing non-draft PREROLL_VIEWS ad group and campaign');
  }
  async context(account: string, raw: z.input<typeof prerollCtaSelection>) {
    const input = prerollCtaSelection.parse(raw), parent = (await this.posts.parents(account, input.line_item_id)).snapshot;this.eligible(parent);
    const active = await this.inventory(account, input.line_item_id), context = { account_id: account, request: input, parent, active_ctas: active };
    return { ...context, context_hash: hash(context), cta_options: prerollCtaValues.map(value => ({ value, label: label(value) })), notes: ['Native POST sets the ad group CTA. Existing active CTA settings must be updated explicitly; this workflow refuses an implicit replacement.', 'Under paused_creation, setting a new CTA requires a currently PAUSED ad group.', ...notices] };
  }
  async get(account: string, id: string) {
    await this.entities.getAccount(account);
    const row = this.scope(account, (await this.entities.client.request('GET', `${this.base(account)}/${xId.parse(id)}`, z.object({ data: nativePrerollCta }), { with_deleted: true })).data, id);
    const parent = (await this.posts.parents(account, row.line_item_id)).snapshot, active = await this.inventory(account, row.line_item_id);
    if (!row.deleted && !active.some(item => equal(item, config(row))) || row.deleted && active.some(item => item.id === row.id)) throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA exact record differs from its current active inventory');
    const contextHash = this.contextHash(account, row, parent, active);
    return { ...row, parent, active_ctas: active, context_hash: contextHash, creatives: [this.card(account, row, parent, contextHash)], truncated: false, notes: notices };
  }
  async list(raw: z.input<typeof prerollCtaList>) {
    const input = prerollCtaList.parse(raw), parent = input.line_item_id ? (await this.posts.parents(input.account_id, input.line_item_id)).snapshot : undefined;
    if (!parent) await this.entities.getAccount(input.account_id);
    const result = await this.page(input.account_id, input.line_item_id, input.count, input.with_deleted, input.cursor);
    const warnings: string[] = [];let active: Cta[] | undefined;
    if (parent && input.line_item_id && result.data.some(row => !row.deleted)) try { active = await this.inventory(input.account_id, input.line_item_id); } catch { warnings.push('Complete CTA context could not be read. These settings remain visible without edit/removal actions; inspect the exact CTA before changing it.'); }
    const records = result.data.map(row => {
      const matched = active?.some(item => equal(item, config(row))), contextHash = matched && active && parent ? this.contextHash(input.account_id, row, parent, active) : undefined;
      if (active && !row.deleted && !matched) warnings.push(`CTA ${row.id} changed during this read; its edit actions are unavailable.`);
      return { row, contextHash };
    });
    const paging = this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor);
    return { items: records.map(({ row, contextHash }) => ({ ...row, ...(contextHash ? { context_hash: contextHash } : {}) })), ...(parent ? { parent } : {}), creatives: records.map(({ row, contextHash }) => this.card(input.account_id, row, parent, contextHash)), warnings, ...paging, notes: [...notices, ...paging.notes ?? []] };
  }
  private unconfirmed(error: unknown, known: string[]): never {
    const prior = error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids) ? error.details.resource_ids.filter((id): id is string => typeof id === 'string' && xId.safeParse(id).success) : [];
    throw new AdportError('PROVIDER_ERROR', 'x: preroll CTA outcome was not confirmed. Reconcile known IDs and current ad-group settings before another mutation; no write was retried.', { resource_ids: [...new Set([...known, ...prior])] });
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = xId.parse(op.accountId), create = op.tool === 'x_create_preroll_cta', update = op.tool === 'x_update_preroll_cta', remove = op.tool === 'x_delete_preroll_cta';
    if (op.provider !== 'x' || !create && !update && !remove || op.kind !== (create ? 'create' : update ? 'update' : 'remove')) throw new AdportError('INVALID_INPUT', 'x: preroll CTA operation provider/kind mismatch');
    const review = (title: string, parent: Parent, fields: ReviewField[]): Omit<Plan, 'execute'> => {
      const scope: ReviewField[] = [{ label: 'Ad group', after: String(parent.line.name ?? parent.line.id) }, { label: 'Parent delivery', after: String(parent.line.entity_status) }, { label: 'Scope', after: 'All preroll ads in this ad group' }];
      const notes = remove ? ['Removing a CTA does not pause preroll ads. Media and ad associations remain.', ...notices] : notices;
      return { summary: title, changes: [...fields, ...scope].map(field => `${field.label}: ${JSON.stringify(field.before)} → ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: { provider: 'x', accountId: account, kind: op.kind, title, fields: [...fields, ...scope], notices: notes } };
    };
    if (create) {
      const { expected_context_hash, acknowledge_ad_group_scope: _ack, ...input } = createPrerollCta.parse(op.payload), context = await this.context(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: preroll CTA creation context changed; read and preview again');
      if (context.active_ctas.length) throw new AdportError('INVALID_INPUT', 'x: the ad group already has active CTA settings; use an explicit CTA update');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: paused_creation requires a currently PAUSED ad group before setting a new CTA');
      const preview = review('Set preroll CTA', context.parent, [{ label: 'Button', after: label(input.call_to_action) }, { label: 'Destination', after: input.call_to_action_url }]);
      const budgetDeltas = [context.parent.line, context.parent.campaign].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const amount = entity[key as keyof typeof entity];return typeof amount === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: amount, toMicros: amount }] : []; }));
      return { ...preview, budgetDeltas, execute: async () => {
        const known: string[] = [];
        try {
          const row = (await this.entities.client.request('POST', this.base(account), z.object({ data: nativePrerollCta }), input)).data;known.push(row.id);this.scope(account, row);
          const expected = { ...input, id: row.id, deleted: false };
          if (!equal(config(row), expected)) throw new Error('CTA creation receipt differs');
          const observed = await this.get(account, row.id);
          if (!equal(config(observed), expected) || !equal(observed.parent, context.parent) || !equal(observed.active_ctas, [expected])) throw new Error('CTA creation readback differs');
          return [row.id];
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    const input = update ? updatePrerollCta.parse(op.payload) : deletePrerollCta.parse(op.payload), current = await this.get(account, input.preroll_call_to_action_id);
    if (current.deleted || current.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: preroll CTA or parent/inventory context changed or was deleted; read and preview again');
    if (update) this.eligible(current.parent);
    const patch: Record<string, string> = {};
    if (update) {
      const edit = updatePrerollCta.parse(op.payload);
      for (const key of ['call_to_action', 'call_to_action_url'] as const) if (edit[key] !== undefined && edit[key] !== current[key]) patch[key] = edit[key];
      if (!Object.keys(patch).length) throw new AdportError('INVALID_INPUT', 'x: change the CTA button or destination before requesting a preview');
    }
    const expected = { ...config(current), ...patch, deleted: remove }, expectedActive = current.active_ctas.flatMap(row => row.id === current.id ? remove ? [] : [expected] : [row]);
    const fields: ReviewField[] = update ? Object.entries(patch).map(([key, value]) => ({ label: key === 'call_to_action' ? 'Button' : 'Destination', before: key === 'call_to_action' ? label(current.call_to_action) : current.call_to_action_url, after: key === 'call_to_action' ? label(value) : value })) : [{ label: 'CTA', after: current.id }, { label: 'Button', before: label(current.call_to_action), after: '(removed)' }, { label: 'Destination', before: current.call_to_action_url, after: '(removed)' }];
    return { ...review(update ? 'Edit preroll CTA' : 'Remove preroll CTA', current.parent, fields), execute: async () => {
      const known = [current.id];
      try {
        const row = (await this.entities.client.request(update ? 'PUT' : 'DELETE', `${this.base(account)}/${current.id}`, z.object({ data: nativePrerollCta }), patch)).data;known.push(row.id);this.scope(account, row);
        if (!equal(config(row), expected)) throw new Error('CTA edit/removal receipt differs');
        const observed = await this.get(account, current.id);
        if (!equal(config(observed), expected) || !equal(observed.parent, current.parent) || !equal(observed.active_ctas, configs(expectedActive))) throw new Error('CTA edit/removal readback differs');
        return [current.id];
      } catch (error) { return this.unconfirmed(error, known); }
    } };
  }
}

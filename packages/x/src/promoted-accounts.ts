import { createHash } from 'node:crypto';
import { AdportError, type Creative, type ReviewField, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { XParams } from './client.js';
import type { XCreativeService } from './creatives.js';
import type { XAdsEntities } from './entities.js';
import type { XPostService } from './posts.js';
import { createPromotedAccount, deletePromotedAccount, nativePromotedAccount, promotedAccountList, promotedAccountSelection } from './promoted-account-schemas.js';
import { xId } from './schemas.js';

type Association = z.infer<typeof nativePromotedAccount>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const pageSchema = z.object({ data: z.array(nativePromotedAccount).max(1000), next_cursor: z.string().nullable().optional() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const configuration = (row: Association) => ({ id: row.id, line_item_id: row.line_item_id, user_id: row.user_id, entity_status: row.entity_status, deleted: row.deleted });
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const notice = 'Local preview is not X validation. Native eligibility remains authoritative, and no write is retried automatically.';

/** Official X v12 promoted_accounts reference, docs09e643bc, checked2026-11-06. */
export class XPromotedAccountService {
  constructor(private readonly entities: XAdsEntities, private readonly creatives: XCreativeService, private readonly posts: XPostService) {}
  private base(account: string) { return `accounts/${xId.parse(account)}`; }
  private scope(account: string, row: Association, id?: string, line?: string) {
    if (row.account_id !== undefined && row.account_id !== account || id !== undefined && row.id !== id || line !== undefined && row.line_item_id !== line) throw new AdportError('PROVIDER_ERROR', 'x: promoted-account resource/account/ad-group mismatch');
    return row;
  }
  private paging(ids: string[], next: string | null | undefined, previous?: string) {
    if (new Set(ids).size !== ids.length || next && next === previous) throw new AdportError('PROVIDER_ERROR', 'x: promoted-account pagination repeated an ID or cursor');
    return { truncated: next !== null, ...(next ? { next_cursor: next } : {}), ...(next === undefined || next === '' ? { notes: ['Native continuation marker is missing; completeness is unconfirmed.'] } : {}) };
  }
  private async page(account: string, line: string, params: XParams) {
    const result = await this.entities.client.request('GET', `${this.base(account)}/promoted_accounts`, pageSchema, { line_item_ids: line, ...params });
    for (const row of result.data) { this.scope(account, row, undefined, line);if (params.with_deleted === false && row.deleted) throw new AdportError('PROVIDER_ERROR', 'x: promoted-account deletion filter mismatch'); }
    this.paging(result.data.map(row => row.id), result.next_cursor, typeof params.cursor === 'string' ? params.cursor : undefined);return result;
  }
  private async existing(account: string, line: string) {
    const rows: Association[] = [], ids = new Set<string>(), cursors = new Set<string>();let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.page(account, line, { count: 200, with_deleted: false, ...(cursor ? { cursor } : {}) });
      for (const row of result.data) { if (ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: promoted-account inventory repeated an ID');ids.add(row.id);rows.push(row); }
      if (result.next_cursor === null) return rows.sort((a, b) => a.id.localeCompare(b.id));
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursor = result.next_cursor;cursors.add(cursor);
    }
    throw new AdportError('PROVIDER_ERROR', 'x: promoted-account inventory is incomplete; no association submitted');
  }
  private associationHash(account: string, row: Association, parent: unknown) { return hash({ account_id: account, association: configuration(row), parent }); }
  async get(account: string, id: string) {
    await this.entities.getAccount(account);
    const row = this.scope(account, (await this.entities.client.request('GET', `${this.base(account)}/promoted_accounts/${xId.parse(id)}`, z.object({ data: nativePromotedAccount }), { with_deleted: true })).data, id);
    const parent = await this.posts.parents(account, row.line_item_id);
    return { ...row, parent: parent.snapshot, context_hash: this.associationHash(account, row, parent.snapshot) };
  }
  private card(account: string, row: Association, parent: Awaited<ReturnType<XPostService['parents']>>['snapshot'], removable: boolean): Creative {
    return { id: row.id, provider: 'x', account_id: account, campaign_id: String(parent.campaign.id), ad_group_id: row.line_item_id, name: `Promoted account ${row.user_id}`, type: 'PROMOTED_ACCOUNT_ASSOCIATION', status: row.deleted ? 'DISASSOCIATED' : row.entity_status, headlines: [], descriptions: [`X profile ${row.user_id}`], landing_urls: [`https://x.com/i/user/${row.user_id}`], media: [], actions: removable && !row.deleted ? [{ label: 'Remove from ad group', tool: 'x_delete_promoted_account', arguments: { account_id: account, promoted_account_id: row.id, expected_context_hash: this.associationHash(account, row, parent) }, fields: [] }] : [] };
  }
  async list(raw: z.input<typeof promotedAccountList>) {
    const input = promotedAccountList.parse(raw), parent = await this.posts.parents(input.account_id, input.line_item_id);
    if (parent.line.product_type !== 'PROMOTED_ACCOUNT') throw new AdportError('INVALID_INPUT', 'x: select a PROMOTED_ACCOUNT ad group');
    const result = await this.page(input.account_id, input.line_item_id, { count: input.count, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}) });
    return { items: result.data.map(row => ({ ...row, context_hash: this.associationHash(input.account_id, row, parent.snapshot) })), parent: parent.snapshot, creatives: result.data.map(row => this.card(input.account_id, row, parent.snapshot, true)), ...this.paging(result.data.map(row => row.id), result.next_cursor, input.cursor), warnings: ['Native ACTIVE describes the association, not parent delivery. Profile content is live; this endpoint supplies identity references rather than profile artwork.', ...(result.data.length > input.count ? ['X returned more rows than requested; all were retained.'] : [])] };
  }
  async context(account: string, raw: z.input<typeof promotedAccountSelection>) {
    const input = promotedAccountSelection.parse(raw), accountState = await this.entities.getAccount(account);
    if (accountState.deleted) throw new AdportError('INVALID_INPUT', 'x: the selected ad account is deleted');
    const parent = await this.posts.parents(account, input.line_item_id);
    if (parent.line.deleted || parent.campaign.deleted || !['ACTIVE', 'PAUSED'].includes(parent.line.entity_status) || !['ACTIVE', 'PAUSED'].includes(parent.campaign.entity_status) || parent.line.product_type !== 'PROMOTED_ACCOUNT' || parent.line.objective !== 'FOLLOWERS') throw new AdportError('INVALID_INPUT', 'x: choose an existing non-draft FOLLOWERS/PROMOTED_ACCOUNT ad group and campaign');
    const users = await this.creatives.users(account, true);
    if (users.some(row => row.account_id !== undefined && row.account_id !== account)) throw new AdportError('PROVIDER_ERROR', 'x: promotable-user account echo mismatch');
    const matches = users.filter(row => row.user_id === input.user_id && !row.deleted);
    if (matches.length !== 1 || matches[0]!.promotable_user_type !== 'FULL') throw new AdportError('INVALID_INPUT', 'x: select one unambiguous current FULL promotable user from this account');
    const row = matches[0]!, user = { id: row.id, user_id: row.user_id, promotable_user_type: row.promotable_user_type, deleted: row.deleted }, existing = await this.existing(account, input.line_item_id);
    const context = { account_id: account, request: input, user, parent: parent.snapshot, existing: existing.map(configuration) };
    return { ...context, context_hash: hash(context), creatives: [{ id: input.user_id, provider: 'x', account_id: account, campaign_id: parent.campaign.id, ad_group_id: input.line_item_id, name: `Profile ${input.user_id}`, type: 'PROMOTABLE_PROFILE', status: 'FULL', headlines: [], descriptions: [], landing_urls: [`https://x.com/i/user/${input.user_id}`], media: [], actions: [] }], truncated: false, notes: ['Native creation adds an ACTIVE association. paused_creation requires a currently PAUSED ad group; parent delivery and budgets are preserved.', 'The promoted identity is bound to this context; live X profile text/artwork is not snapshotted, uploaded or edited. No post is published and no new profile is created.', 'Snapshots do not atomically lock concurrent native changes. Reconcile unknown outcomes before another request.', notice] };
  }
  private unconfirmed(error: unknown, known: string[]): never {
    const previous = error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids) ? error.details.resource_ids.filter((id): id is string => typeof id === 'string' && xId.safeParse(id).success) : [];
    throw new AdportError('PROVIDER_ERROR', 'x: promoted-account association outcome unconfirmed. Inspect known IDs and current inventory before another mutation; no write was retried.', { resource_ids: [...new Set([...known, ...previous])] });
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    const account = xId.parse(op.accountId), create = op.tool === 'x_create_promoted_account';
    if (op.provider !== 'x' || !['x_create_promoted_account', 'x_delete_promoted_account'].includes(op.tool) || op.kind !== (create ? 'create' : 'remove')) throw new AdportError('INVALID_INPUT', 'x: promoted-account operation provider/kind mismatch');
    const review = (title: string, fields: ReviewField[], notes: string[]): Omit<Plan, 'execute'> => ({ summary: title, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: { provider: 'x', accountId: account, kind: op.kind, title, fields, notices: notes } });
    if (create) {
      const { expected_context_hash, acknowledge_active_association: _active, acknowledge_live_profile: _profile, ...input } = createPromotedAccount.parse(op.payload), context = await this.context(account, input);
      if (context.context_hash !== expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: promoted identity/parent/association context changed; read and preview again');
      if (context.existing.some(row => row.user_id === input.user_id)) throw new AdportError('INVALID_INPUT', 'x: this user is already promoted in the ad group; do not replay creation');
      if (guard.forcePausedCreation && context.parent.line.entity_status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'x: native profile associations are ACTIVE; paused_creation requires a currently PAUSED ad group');
      const budgetDeltas = [context.parent.campaign, context.parent.line].flatMap(entity => ['daily_budget_amount_local_micro', 'total_budget_amount_local_micro'].flatMap(key => { const value = entity[key as keyof typeof entity];return typeof value === 'number' ? [{ target: `${entity.id} ${key} existing pool`, currency: context.parent.campaign.currency, fromMicros: value, toMicros: value }] : []; }));
      return { ...review('Promote X account', [{ label: 'Profile user ID', after: input.user_id }, { label: 'Ad group', after: input.line_item_id }, { label: 'Campaign', after: context.parent.campaign.id }, { label: 'Native association status', after: 'ACTIVE' }, { label: 'Parent delivery', after: String(context.parent.line.entity_status) }, { label: 'Profile content', after: 'Live X profile; not snapshotted or edited' }], context.notes), budgetDeltas, execute: async () => {
        const known: string[] = [];
        try {
          const row = (await this.entities.client.request('POST', `${this.base(account)}/promoted_accounts`, z.object({ data: nativePromotedAccount }), input)).data;known.push(row.id);this.scope(account, row, undefined, input.line_item_id);
          if (context.existing.some(prior => prior.id === row.id) || row.deleted || row.entity_status !== 'ACTIVE' || row.user_id !== input.user_id) throw new Error('Promoted-account receipt differs');
          const observed = await this.get(account, row.id);
          if (!equal(configuration(row), configuration(observed)) || !equal(observed.parent, context.parent)) throw new Error('Promoted-account readback/parent differs');
          return [row.id];
        } catch (error) { return this.unconfirmed(error, known); }
      } };
    }
    const input = deletePromotedAccount.parse(op.payload), current = await this.get(account, input.promoted_account_id);
    if (current.deleted || current.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: promoted-account association/parent changed or was deleted; read and preview again');
    return { ...review('Remove promoted account from ad group', [{ label: 'Association', after: current.id }, { label: 'Profile retained', after: current.user_id }, { label: 'Ad group', after: current.line_item_id }, { label: 'Deleted', before: false, after: true }], ['Removes this one ad association. The X profile, other associations, posts and parent delivery/budgets are retained.', 'A deleted tombstone may retain native ACTIVE status. No PUT edit or profile deletion occurs.', notice]), execute: async () => {
      const known = [current.id];
      try {
        const row = (await this.entities.client.request('DELETE', `${this.base(account)}/promoted_accounts/${current.id}`, z.object({ data: nativePromotedAccount }))).data;known.push(row.id);this.scope(account, row, current.id, current.line_item_id);
        const observed = await this.get(account, current.id), matches = (value: Association) => value.id === current.id && value.line_item_id === current.line_item_id && value.user_id === current.user_id && value.deleted;
        if (!matches(row) || !matches(observed) || !equal(observed.parent, current.parent)) throw new Error('Promoted-account deletion/readback differs');
        return [current.id];
      } catch (error) { return this.unconfirmed(error, known); }
    } };
  }
}

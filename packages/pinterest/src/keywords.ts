import { createHash } from 'node:crypto';
import { AdportError, creativesOutput, defineTool, guardedWriteTool, planningViewSchema, type AnyToolDefinition, type Creative, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { PinterestAdsClient } from './client.js';
import type { PinterestAdsProvider } from './provider.js';
import { pinterestId as id } from './schemas.js';

type Row = Record<string, unknown>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute: () => Promise<string[]> };
const hash = z.string().regex(/^[a-f0-9]{64}$/), cursor = z.string().min(1).max(4096);
const parent = z.discriminatedUnion('type', [z.object({ type: z.literal('account') }).strict(), z.object({ type: z.literal('campaign'), campaign_id: id }).strict(), z.object({ type: z.literal('ad_group'), ad_group_id: id }).strict()]);
const match = z.enum(['BROAD', 'PHRASE', 'EXACT', 'EXACT_NEGATIVE', 'PHRASE_NEGATIVE']);
const keyword = z.looseObject({ id, parent_id: id, parent_type: z.string().optional(), match_type: match.nullable(), value: z.string(), archived: z.boolean().optional(), bid: z.number().int().nullable().optional() });
type Keyword = z.infer<typeof keyword>;
const reference = { parent, expected_parent_hash: hash };
const create = z.object({ ...reference, keywords: z.array(z.object({ value: z.string().trim().min(1).max(120), match_type: match }).strict()).min(1).max(100) }).strict().superRefine((v, ctx) => {
  if (new Set(v.keywords.map(k => `${k.match_type}:${k.value}`)).size !== v.keywords.length) ctx.addIssue({ code: 'custom', message: 'Use unique keyword/match-type pairs' });
  if (v.parent.type !== 'ad_group' && v.keywords.some(k => !k.match_type.endsWith('_NEGATIVE'))) ctx.addIssue({ code: 'custom', message: 'Account and campaign parents accept only negative keywords' });
});
const archive = z.object({ ...reference, keywords: z.array(z.object({ keyword_id: id, expected_snapshot_hash: hash }).strict()).min(1).max(100) }).strict().refine(v => new Set(v.keywords.map(k => k.keyword_id)).size === v.keywords.length, 'Use unique keyword IDs');
type Parent = z.infer<typeof parent>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (value: Keyword) => digest({ id: value.id, parent_id: value.parent_id, parent_type: value.parent_type ?? null, match_type: value.match_type, value: value.value, archived: value.archived ?? null });
const writes = new Set(['pinterest_create_keywords', 'pinterest_archive_keywords']);

/** Pinterest-owned v5 OpenAPI5.28.0 /keywords, fetched 2026-11-04. */
export class PinterestKeywordService {
  constructor(private readonly client: PinterestAdsClient, private readonly entity: (account: string, type: 'campaigns' | 'ad_groups', resource: string) => Promise<Row>) {}
  supports(tool: string) { return writes.has(tool); }
  private base(account: string) { return `ad_accounts/${id.parse(account)}/keywords`; }
  async context(account: string, selected: Parent) {
    const scope = parent.parse(selected);
    let entity: Row, campaign: Row | undefined;
    if (scope.type === 'account') {
      entity = await this.client.get(`ad_accounts/${id.parse(account)}`, z.looseObject({ id }));
      if (entity.id !== account) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword account response mismatch');
    } else if (scope.type === 'campaign') entity = await this.entity(account, 'campaigns', scope.campaign_id);
    else { entity = await this.entity(account, 'ad_groups', scope.ad_group_id); campaign = await this.entity(account, 'campaigns', id.parse(entity.campaign_id)); }
    const parentId = id.parse(entity.id), configuration = { account_id: account, parent: scope, parent_id: parentId, status: entity.status ?? null, ...(campaign ? { campaign_id: campaign.id, campaign_status: campaign.status ?? null } : {}) };
    return { ...configuration, entity, ...(campaign ? { campaign } : {}), parent_snapshot_hash: digest(configuration), notes: ['Account scope lists account-level negative keywords only. Campaign/ad-group keywords need their explicit parent.', 'Keywords have no native pause flag. Keyword bids are deprecated and are not exposed as writable controls.'] };
  }
  private scoped(value: Keyword, context: { parent: Parent; parent_id: string }) {
    const types = context.parent.type === 'account' ? ['advertiser', 'account', 'adaccount'] : context.parent.type === 'campaign' ? ['campaign'] : ['adgroup'];
    if (value.parent_id !== context.parent_id || value.parent_type && !types.includes(value.parent_type.toLowerCase().replaceAll('_', ''))) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword collection returned another parent');
    return value;
  }
  private async page(account: string, context: Awaited<ReturnType<PinterestKeywordService['context']>>, size: number, bookmark?: string, matches?: z.infer<typeof match>[]) {
    const params = new URLSearchParams({ page_size: String(size) });
    if (context.parent.type === 'campaign') params.set('campaign_id', context.parent_id);
    if (context.parent.type === 'ad_group') params.set('ad_group_id', context.parent_id);
    if (bookmark) params.set('bookmark', bookmark);
    if (matches) params.set('match_types', matches.join(','));
    const data = await this.client.get(this.base(account), z.object({ items: z.array(keyword), bookmark: z.string().nullable().optional() }), params);
    if (data.items.length > size || new Set(data.items.map(v => v.id)).size !== data.items.length || data.bookmark && (!data.items.length || data.bookmark === bookmark)) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword pagination did not advance or returned duplicate/oversized rows');
    if (matches && data.items.some(v => v.match_type === null || !matches.includes(v.match_type))) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword collection ignored the match-type selection');
    return { ...data, items: data.items.map(v => this.scoped(v, context)), truncated: Boolean(data.bookmark), ...(data.bookmark ? { next_cursor: data.bookmark } : {}) };
  }
  private view(account: string, scope: Parent, parentHash: string, item: Keyword): Creative {
    return { id: item.id, provider: 'pinterest', account_id: account, name: item.value, type: `${item.match_type ?? 'UNKNOWN'}_KEYWORD`, status: item.archived === true ? 'ARCHIVED' : item.archived === false ? 'UNARCHIVED' : 'UNKNOWN', headlines: [item.value], descriptions: [], landing_urls: [], media: [], actions: item.archived === false ? [{ label: 'Archive keyword', tool: 'pinterest_archive_keywords', arguments: { account_id: account, parent: scope, expected_parent_hash: parentHash, keywords: [{ keyword_id: item.id, expected_snapshot_hash: snapshot(item) }] }, fields: [] }] : [] };
  }
  async list(input: { account_id: string; parent: Parent; page_size: number; bookmark?: string; match_types?: z.infer<typeof match>[] }) {
    const context = await this.context(input.account_id, input.parent), data = await this.page(input.account_id, context, input.page_size, input.bookmark, input.match_types);
    return { ...data, parent: context.parent, parent_id: context.parent_id, parent_snapshot_hash: context.parent_snapshot_hash, items: data.items.map(value => ({ ...value, snapshot_hash: snapshot(value) })), creatives: data.items.map(value => this.view(input.account_id, context.parent, context.parent_snapshot_hash, value)), notes: context.notes };
  }
  private async find(account: string, context: Awaited<ReturnType<PinterestKeywordService['context']>>, wanted: Set<string>) {
    const found = new Map<string, Keyword>(), cursors = new Set<string>(), seen = new Set<string>();
    let bookmark: string | undefined;
    for (let page = 0; page < 40; page++) {
      const result = await this.page(account, context, 250, bookmark);
      for (const row of result.items) {
        if (seen.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword inventory repeated an ID'); seen.add(row.id);
        if (wanted.has(row.id)) found.set(row.id, row);
      }
      if (found.size === wanted.size) return found;
      if (!result.next_cursor) throw new AdportError('INVALID_INPUT', 'pinterest: requested keyword is not visible in this parent; archived keywords cannot be safely rediscovered/unarchived through this API');
      if (cursors.has(result.next_cursor)) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword inventory repeated a cursor');
      cursors.add(result.next_cursor); bookmark = result.next_cursor;
    }
    throw new AdportError('INVALID_INPUT', 'pinterest: keyword ownership lookup exceeded 10,000 rows; no write was made');
  }
  async get(account: string, scope: Parent, keywordId: string) {
    const context = await this.context(account, scope), found = (await this.find(account, context, new Set([keywordId]))).get(keywordId)!;
    return { keyword: found, snapshot_hash: snapshot(found), parent_snapshot_hash: context.parent_snapshot_hash, creatives: [this.view(account, scope, context.parent_snapshot_hash, found)], truncated: false, notes: context.notes };
  }
  async metrics(input: { account_id: string; country_code: string; keywords: string[] }) {
    const data = await this.client.get(`${this.base(input.account_id)}/metrics`, z.object({ data: z.array(z.looseObject({ keyword: z.string(), metrics: z.looseObject({ keyword_query_volume: z.string().optional() }).optional() })) }), new URLSearchParams({ country_code: input.country_code, keywords: input.keywords.join(',') }));
    const wanted = new Set(input.keywords), seen = new Set<string>();
    for (const item of data.data) { if (!wanted.has(item.keyword) || seen.has(item.keyword)) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword metrics returned another or repeated keyword'); seen.add(item.keyword); }
    return { ...data, country_code: input.country_code, truncated: false, planning: { title: 'Pinterest keyword search frequency', columns: [{ key: 'keyword', label: 'Keyword' }, { key: 'volume', label: 'Native frequency' }], rows: input.keywords.map(value => ({ keyword: value, volume: data.data.find(item => item.keyword === value)?.metrics?.keyword_query_volume ?? null })), notes: ['Aggregated across Pinterest in the selected country, not account performance or campaign delivery.', 'Native ranges such as 5M+ remain strings. Missing values remain unavailable; no counts are invented.'] } };
  }
  private async batch(account: string, context: Awaited<ReturnType<PinterestKeywordService['context']>>, method: 'POST' | 'PATCH', body: Row, expected: Array<{ id?: string; value?: string; match_type?: string | null; archived?: boolean }>) {
    const data = await this.client.mutate(this.base(account), method, body, z.object({ keywords: z.array(z.unknown()), errors: z.array(z.unknown()) }));
    const ids = data.keywords.flatMap(value => { const parsed = z.object({ id }).safeParse(value); return parsed.success ? [parsed.data.id] : []; });
    const parsed = z.array(keyword).safeParse(data.keywords);
    if (data.errors.length || !parsed.success || parsed.data.length !== expected.length || new Set(ids).size !== ids.length) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword batch was partial or incomplete; reconcile returned IDs before retrying', { resource_ids: ids });
    const unmatched = [...expected];
    for (const row of parsed.data) {
      try { this.scoped(row, context); } catch { throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword receipt belongs to another parent; reconcile before retrying', { resource_ids: ids }); }
      const index = unmatched.findIndex(item => Object.entries(item).every(([key, value]) => row[key] === value));
      if (index < 0) throw new AdportError('PROVIDER_ERROR', 'pinterest: keyword receipt differs from approved keywords; reconcile before retrying', { resource_ids: ids });
      unmatched.splice(index, 1);
    }
    return ids;
  }
  async plan(op: WriteOperation, guard: WriteGuard): Promise<Plan> {
    if (op.provider !== 'pinterest' || !this.supports(op.tool) || op.kind !== (op.tool === 'pinterest_create_keywords' ? 'create' : 'update')) throw new AdportError('INVALID_INPUT', 'pinterest: invalid keyword operation');
    const input = op.tool === 'pinterest_create_keywords' ? create.parse(op.payload) : archive.parse(op.payload), context = await this.context(op.accountId, input.parent);
    if (context.parent_snapshot_hash !== input.expected_parent_hash) throw new AdportError('PENDING_MISMATCH', 'pinterest: keyword parent state changed; read its context again');
    const notes = ['Preview is local; Pinterest has no server dry-run for keyword writes.', ...context.notes];
    if (op.tool === 'pinterest_create_keywords') {
      const value = create.parse(input), positive = value.keywords.some(item => !item.match_type.endsWith('_NEGATIVE'));
      if (guard.forcePausedCreation && positive && context.entity.status !== 'PAUSED' && context.campaign?.status !== 'PAUSED') throw new AdportError('POLICY_VIOLATION', 'pinterest: positive keywords cannot be paused individually; paused_creation requires a paused parent ad group or campaign');
      return { summary: `Create ${value.keywords.length} Pinterest keywords`, changes: [`Parent ${context.parent.type} ${context.parent_id}.`, ...value.keywords.map(item => `${item.match_type}: ${item.value}`), 'Keyword bids are omitted; existing ad-group bidding is preserved.'], coercions: [], budgetDeltas: [], notes, execute: () => this.batch(op.accountId, context, 'POST', { parent_id: context.parent_id, keywords: value.keywords }, value.keywords.map(item => ({ ...item, archived: false }))) };
    }
    const value = archive.parse(input), current = await this.find(op.accountId, context, new Set(value.keywords.map(item => item.keyword_id)));
    for (const item of value.keywords) if (snapshot(current.get(item.keyword_id)!) !== item.expected_snapshot_hash || current.get(item.keyword_id)!.archived !== false) throw new AdportError('PENDING_MISMATCH', 'pinterest: keyword contents or archive state changed; read it again');
    return { summary: `Archive ${value.keywords.length} Pinterest keywords`, changes: [...current.values()].map(item => `${item.match_type}: ${item.value} (${item.id}) → archived`), coercions: [], budgetDeltas: [], notes: [...notes, 'Archiving removes keywords from native lists and metrics. Removing exclusions can broaden matching; this does not pause the parent or promise an undo path.'], execute: () => this.batch(op.accountId, context, 'PATCH', { keywords: value.keywords.map(item => ({ id: item.keyword_id, archived: true })) }, value.keywords.map(item => ({ id: item.keyword_id, value: current.get(item.keyword_id)!.value, match_type: current.get(item.keyword_id)!.match_type, archived: true }))) };
  }
}

export function pinterestKeywordTools(provider: PinterestAdsProvider): AnyToolDefinition[] {
  const account = { account_id: id }, selected = { ...account, parent: parent.default({ type: 'account' }) };
  return [
    defineTool({ name: 'pinterest_keyword_context', namespace: 'pinterest', description: 'Read an explicit account/campaign/ad-group keyword parent and its snapshot. Account scope means account exclusions only, not all campaign/group keywords. Keywords have no pause flag; bids are deprecated.', input: z.object(selected), annotations: { readOnly: true }, handler: v => provider.keywords.context(v.account_id, v.parent) }),
    defineTool({ name: 'pinterest_keywords', namespace: 'pinterest', description: 'List one verified parent’s native keywords, copy snapshots and guarded archive actions. Native bookmark pagination; UNARCHIVED is keyword state, not delivery. Account scope excludes campaign/ad-group keywords.', input: z.object({ ...selected, page_size: z.number().int().min(1).max(250).default(50), bookmark: cursor.optional(), match_types: z.array(match).min(1).max(5).optional() }), output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'bookmark' }, annotations: { readOnly: true }, handler: v => provider.keywords.list(v) }),
    defineTool({ name: 'pinterest_get_keyword', namespace: 'pinterest', description: 'Find an exact keyword in one owned parent, with a current snapshot. Native API has no GET-by-keyword-ID; lookup is bounded to 10,000 rows. Archived keywords disappear and cannot be safely unarchived here.', input: z.object({ ...selected, keyword_id: id }), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: v => provider.keywords.get(v.account_id, v.parent, v.keyword_id) }),
    defineTool({ name: 'pinterest_keyword_metrics', namespace: 'pinterest', description: 'Read country-wide native search-frequency ranges for up to 100 keywords. Keeps values such as 5M+ as strings; no account-performance, bid or delivery change.', input: z.object({ ...account, country_code: z.string().regex(/^[A-Z]{2}$/), keywords: z.array(z.string().trim().min(1).max(120).refine(v => !v.includes(','), 'Commas cannot be represented within the native CSV keyword query')).min(1).max(100).refine(v => new Set(v).size === v.length, 'Use unique keywords') }), output: z.object({ planning: planningViewSchema }).passthrough(), presentation: 'planning', annotations: { readOnly: true }, handler: v => provider.keywords.metrics(v) }),
    guardedWriteTool({ name: 'pinterest_create_keywords', namespace: 'pinterest', provider: 'pinterest', kind: 'create', description: 'Create up to 100 keywords on a snapshot-bound owned parent. Accounts/campaigns accept only negatives; positive group keywords require a paused group or campaign under paused_creation. No keyword bid input: native bids are deprecated. Partial receipts retain IDs and are never retried.', payload: create }),
    guardedWriteTool({ name: 'pinterest_archive_keywords', namespace: 'pinterest', provider: 'pinterest', kind: 'update', description: 'Archive exact snapshot-bound keywords in one owned parent. Native archive acts like deletion and removes metrics/list visibility; no guaranteed unarchive path. Removing exclusions can broaden matching. No parent status or bid changes.', payload: archive }),
  ];
}

import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { GoogleAdsRestClient, normalizeCustomerId } from './client.js';
import type { GoogleAdsProvider } from './provider.js';

type Row = Record<string, unknown>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(validateOnly: boolean): Promise<string[]>; resultDetails(): unknown }
interface Keyword { text: string; match_type: 'EXACT' | 'PHRASE' | 'BROAD' }
interface Existing extends Keyword { resourceName: string; criterionId: string }
interface Campaign { id: string; name: string; status: string; resourceName: string }

/** Operations per mutate request; Google's hard limit is 10,000 per request. */
export const NEGATIVE_KEYWORD_MUTATE_BATCH = 1000;
/**
 * Google Ads limits: keywords per negative keyword list and negative keywords per campaign.
 * Account-level list counts and channel-specific caps are left to the validate_only dry run.
 */
const LIST_LIMIT = 5000, CAMPAIGN_LIMIT = 10_000, OPERATION_BOUND = 20_000, SAMPLE = 10;
const id = z.string().regex(/^[1-9]\d*$/);
const keyword = z.object({ text: z.string().trim().min(1).max(80), match_type: z.enum(['EXACT', 'PHRASE', 'BROAD']) });
const keywords = z.array(keyword).min(1).max(LIST_LIMIT);
const campaignIds = z.array(id).min(1).max(100);
const createList = z.object({ name: z.string().trim().min(1).max(255), keywords, campaign_ids: campaignIds.optional() });
const updateList = z.object({ shared_set_id: id, add_keywords: keywords.optional(), remove_keywords: keywords.optional() }).refine(value => value.add_keywords !== undefined || value.remove_keywords !== undefined, 'Supply add_keywords or remove_keywords');
const linkList = z.object({ shared_set_id: id, action: z.enum(['attach', 'detach']), campaign_ids: campaignIds });
const campaignNegatives = z.object({ campaign_ids: campaignIds, keywords });
export const GOOGLE_NEGATIVE_KEYWORD_WRITES = new Set(['google_create_negative_keyword_list', 'google_update_negative_keyword_list', 'google_link_negative_keyword_list', 'google_add_campaign_negative_keywords']);
const kinds: Record<string, WriteOperation['kind']> = { google_create_negative_keyword_list: 'create', google_update_negative_keyword_list: 'update', google_link_negative_keyword_list: 'update', google_add_campaign_negative_keywords: 'create' };
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ');
const keyOf = (value: Keyword) => `${value.match_type}:${normalized(value.text).toLowerCase()}`;
/** Google notation: [exact], "phrase", broad. */
export const formatKeyword = (value: Keyword) => value.match_type === 'EXACT' ? `[${value.text}]` : value.match_type === 'PHRASE' ? `"${value.text}"` : value.text;
const sample = (values: Keyword[]) => values.length <= SAMPLE ? values.map(formatKeyword) : [...values.slice(0, SAMPLE).map(formatKeyword), `… and ${values.length - SAMPLE} more`];
const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** A request Google answered, but whose receipt could not be confirmed: it may have been applied. */
class ReceiptMismatch extends AdportError {
  constructor(readonly unconfirmed: number) { super('PROVIDER_ERROR', 'google: negative keyword mutation receipt mismatch'); }
}

/** Case-insensitive text + match type deduplication, keeping the first spelling. */
export function dedupeKeywords(values: Keyword[]) {
  const seen = new Set<string>(), unique: Keyword[] = [], duplicates: Keyword[] = [];
  for (const value of values) {
    const item = { text: normalized(value.text), match_type: value.match_type }, key = keyOf(item);
    if (seen.has(key)) duplicates.push(item); else { seen.add(key); unique.push(item); }
  }
  return { unique, duplicates };
}

/**
 * Wire contracts: Google Ads API v25 SharedSet, SharedCriterion, CampaignSharedSet
 * and CampaignCriterion resources and services (developers.google.com/google-ads/api,
 * checked 2026-11-25).
 */
export class GoogleNegativeKeywordService {
  constructor(private readonly client: GoogleAdsRestClient) {}

  private listResource(account: string, listId: string) { return `customers/${account}/sharedSets/${listId}`; }

  private parseList(account: string, value: unknown) {
    const row = object(value);
    if (!id.safeParse(row.id).success || row.resourceName !== this.listResource(account, String(row.id)) || row.type !== 'NEGATIVE_KEYWORDS' || row.status !== 'ENABLED' || typeof row.name !== 'string') throw new AdportError('PROVIDER_ERROR', 'google: negative keyword list response has an invalid identity, type or status');
    return { id: String(row.id), name: row.name, status: 'ENABLED', member_count: Number(row.memberCount ?? 0), reference_count: Number(row.referenceCount ?? 0), resource_name: String(row.resourceName) };
  }

  private async readLists(account: string, listId?: string) {
    const rows = await this.client.search(account, `SELECT shared_set.resource_name, shared_set.id, shared_set.name, shared_set.type, shared_set.status, shared_set.member_count, shared_set.reference_count FROM shared_set WHERE shared_set.type = 'NEGATIVE_KEYWORDS' AND shared_set.status = 'ENABLED'${listId ? ` AND shared_set.id = ${listId}` : ''} ORDER BY shared_set.id ASC LIMIT 1001`, { maxRows: 1001 });
    if (rows.length > 1000) throw new AdportError('PROVIDER_ERROR', 'google: negative keyword list inventory exceeds the 1,000 list safety bound');
    return rows.map(row => this.parseList(account, row.sharedSet));
  }

  private async list(account: string, listId: string) {
    const lists = await this.readLists(account, listId);
    if (lists.length !== 1 || lists[0]!.id !== listId) throw new AdportError('INVALID_INPUT', 'google: enabled negative keyword list was not found in the selected account');
    return lists[0]!;
  }

  private async links(account: string, listResources: string[]) {
    if (!listResources.length) return [];
    const rows = await this.client.search(account, `SELECT campaign_shared_set.resource_name, campaign_shared_set.campaign, campaign_shared_set.shared_set, campaign_shared_set.status, campaign.id, campaign.name, campaign.status FROM campaign_shared_set WHERE campaign_shared_set.shared_set IN (${listResources.map(value => `'${value}'`).join(', ')}) AND campaign_shared_set.status = 'ENABLED' AND campaign.status != 'REMOVED' LIMIT 10001`, { maxRows: 10_001 });
    if (rows.length > 10_000) throw new AdportError('PROVIDER_ERROR', 'google: campaign list attachments exceed the 10,000 row safety bound');
    return rows.map(row => {
      const link = object(row.campaignSharedSet), campaign = object(row.campaign), listId = String(link.sharedSet ?? '').match(new RegExp(`^customers/${account}/sharedSets/([1-9]\\d*)$`))?.[1];
      if (!listId || !listResources.includes(String(link.sharedSet)) || !id.safeParse(campaign.id).success || link.campaign !== `customers/${account}/campaigns/${campaign.id}` || link.resourceName !== `customers/${account}/campaignSharedSets/${campaign.id}~${listId}`) throw new AdportError('PROVIDER_ERROR', 'google: campaign list attachment identity mismatch');
      return { list_id: listId, resource_name: String(link.resourceName), campaign: { id: String(campaign.id), name: String(campaign.name ?? ''), status: String(campaign.status ?? '') } };
    });
  }

  private async criteria(account: string, listId: string) {
    const rows = await this.client.search(account, `SELECT shared_criterion.resource_name, shared_criterion.shared_set, shared_criterion.criterion_id, shared_criterion.type, shared_criterion.keyword.text, shared_criterion.keyword.match_type FROM shared_criterion WHERE shared_criterion.shared_set = '${this.listResource(account, listId)}' AND shared_criterion.type = 'KEYWORD' ORDER BY shared_criterion.criterion_id ASC LIMIT ${LIST_LIMIT + 1}`, { maxRows: LIST_LIMIT + 1 });
    if (rows.length > LIST_LIMIT) throw new AdportError('PROVIDER_ERROR', 'google: negative keyword list exceeds the 5,000 keyword list limit');
    return rows.map((row): Existing => {
      const value = object(row.sharedCriterion), info = object(value.keyword), parsed = keyword.safeParse({ text: info.text, match_type: info.matchType });
      if (!parsed.success || !id.safeParse(value.criterionId).success || value.sharedSet !== this.listResource(account, listId) || value.resourceName !== `customers/${account}/sharedCriteria/${listId}~${value.criterionId}`) throw new AdportError('PROVIDER_ERROR', 'google: negative keyword list criterion identity or keyword mismatch');
      return { ...parsed.data, resourceName: String(value.resourceName), criterionId: String(value.criterionId) };
    });
  }

  private async campaigns(account: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (unique.length !== ids.length) throw new AdportError('INVALID_INPUT', 'google: campaign_ids contains duplicates');
    const rows = await this.client.search(account, `SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.id IN (${unique.join(', ')}) AND campaign.status != 'REMOVED' LIMIT ${unique.length + 1}`, { maxRows: unique.length + 1 });
    const found = new Map<string, Campaign>();
    for (const row of rows) {
      const value = object(row.campaign);
      if (!unique.includes(String(value.id)) || found.has(String(value.id)) || value.resourceName !== `customers/${account}/campaigns/${value.id}` || !['ENABLED', 'PAUSED'].includes(String(value.status))) throw new AdportError('PROVIDER_ERROR', 'google: campaign identity or status mismatch');
      found.set(String(value.id), { id: String(value.id), name: String(value.name ?? ''), status: String(value.status), resourceName: String(value.resourceName) });
    }
    const missing = unique.filter(value => !found.has(value));
    if (missing.length) throw new AdportError('INVALID_INPUT', `google: campaigns not found or removed in the selected account: ${missing.join(', ')}`);
    return unique.map(value => found.get(value)!);
  }

  private async campaignNegatives(account: string, campaign: Campaign) {
    const rows = await this.client.search(account, `SELECT campaign.id, campaign_criterion.resource_name, campaign_criterion.campaign, campaign_criterion.criterion_id, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign.id = ${campaign.id} AND campaign_criterion.type = 'KEYWORD' AND campaign_criterion.negative = TRUE AND campaign_criterion.status != 'REMOVED' LIMIT ${CAMPAIGN_LIMIT + 1}`, { maxRows: CAMPAIGN_LIMIT + 1 });
    if (rows.length > CAMPAIGN_LIMIT) throw new AdportError('PROVIDER_ERROR', 'google: campaign negative keywords exceed the 10,000 criterion safety bound');
    return rows.map((row): Existing => {
      const value = object(row.campaignCriterion), info = object(value.keyword), parsed = keyword.safeParse({ text: info.text, match_type: info.matchType });
      if (!parsed.success || value.negative !== true || value.campaign !== campaign.resourceName || value.resourceName !== `customers/${account}/campaignCriteria/${campaign.id}~${value.criterionId}`) throw new AdportError('PROVIDER_ERROR', 'google: campaign negative keyword identity mismatch');
      return { ...parsed.data, resourceName: String(value.resourceName), criterionId: String(value.criterionId) };
    });
  }

  /** Every enabled list, or one list (shared_set_id) with its keywords up to limit. */
  async listLists(input: { account_id: string; shared_set_id?: string | undefined; limit?: number | undefined }) {
    const account = normalizeCustomerId(input.account_id), lists = input.shared_set_id ? [await this.list(account, input.shared_set_id)] : await this.readLists(account);
    const links = await this.links(account, lists.map(list => list.resource_name)), limit = input.limit ?? 1000;
    const criteria = input.shared_set_id ? await this.criteria(account, input.shared_set_id) : undefined;
    return { lists: lists.map(({ resource_name: _resource, status: _status, ...list }) => ({ ...list, campaigns: links.filter(link => link.list_id === list.id).map(link => link.campaign),
      ...(criteria ? { keywords: criteria.slice(0, limit).map(value => ({ criterion_id: value.criterionId, text: value.text, match_type: value.match_type })), truncated: criteria.length > limit } : {}) })) };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'google' || !GOOGLE_NEGATIVE_KEYWORD_WRITES.has(op.tool) || op.kind !== kinds[op.tool]) throw new AdportError('INVALID_INPUT', 'google: negative keyword operation kind mismatch');
    const account = normalizeCustomerId(op.accountId);
    if (op.tool === 'google_create_negative_keyword_list') return this.planCreate(account, createList.parse(op.payload));
    if (op.tool === 'google_update_negative_keyword_list') return this.planUpdate(account, updateList.parse(op.payload));
    if (op.tool === 'google_add_campaign_negative_keywords') return this.planCampaignNegatives(account, campaignNegatives.parse(op.payload));
    const link = linkList.parse(op.payload);
    return this.planLink(account, link, link.action === 'attach');
  }

  /** Runs service mutates in bounded batches; each request is atomic (partialFailure=false). */
  private async batches(account: string, service: string, operations: Row[], validateOnly: boolean, expected: (operation: Row, resource: string) => boolean, acknowledged: string[]) {
    for (const batch of chunks(operations, NEGATIVE_KEYWORD_MUTATE_BATCH)) {
      const result = await this.client.mutate(account, service, batch, { validateOnly });
      if (validateOnly) continue;
      const resources = (result.results ?? []).map(value => value.resourceName ?? '');
      if (resources.length !== batch.length || resources.some((resource, index) => !expected(batch[index]!, resource))) throw new ReceiptMismatch(batch.length);
      acknowledged.push(...resources);
    }
  }

  private outcome(error: unknown, acknowledged: string[], total: number, guidance: string, details: Row = {}) {
    // Only a request Google rejected outright, before anything was confirmed, is
    // known to have changed nothing; anything else may have been applied.
    const unconfirmed = error instanceof ReceiptMismatch ? error.unconfirmed : 0;
    if (!acknowledged.length && !unconfirmed && error instanceof AdportError) return error;
    const pending = unconfirmed ? ` A request of ${plural(unconfirmed, 'operation')} was sent but its receipt could not be confirmed; it may have been applied.` : '';
    return new AdportError('PROVIDER_ERROR', `google: negative keyword change stopped after ${acknowledged.length} of ${total} confirmed operations.${pending} ${guidance} Each request is atomic; earlier batches remain applied.`, { resourceIds: acknowledged, ...(unconfirmed ? { unconfirmed_operations: unconfirmed } : {}), ...details, cause: error instanceof Error ? error.message : String(error) });
  }

  private review(account: string, kind: WriteOperation['kind'], title: string, subject: string, fields: ReviewField[], notices: string[]) {
    return { provider: 'google', accountId: account, kind, title, subject, fields, notices };
  }

  private async planCreate(account: string, input: z.infer<typeof createList>): Promise<Plan> {
    const { unique, duplicates } = dedupeKeywords(input.keywords);
    const lists = await this.readLists(account), name = input.name.toLowerCase();
    if (lists.some(list => list.name.toLowerCase() === name)) throw new AdportError('INVALID_INPUT', `google: an enabled negative keyword list named "${input.name}" already exists; use google_update_negative_keyword_list`);
    const campaigns = input.campaign_ids ? await this.campaigns(account, input.campaign_ids) : [];
    const temp = `customers/${account}/sharedSets/-1`, chunkSize = NEGATIVE_KEYWORD_MUTATE_BATCH - 1;
    const criterion = (sharedSet: string, value: Keyword) => ({ sharedSet, keyword: { text: value.text, matchType: value.match_type } });
    const requestCount = Math.ceil(unique.length / chunkSize) + (campaigns.length ? 1 : 0);
    const notices = ['A negative keyword list only blocks matching searches once attached; it has no pause state. Attaching it to an enabled campaign affects delivery immediately. Budgets, bids and statuses are unchanged.', `Keywords are deduplicated by text and match type, ignoring case. Applied in ${plural(requestCount, 'atomic request')} of at most ${NEGATIVE_KEYWORD_MUTATE_BATCH} operations; campaigns are attached only after every keyword is added.`];
    const fields: ReviewField[] = [{ label: 'List name', after: input.name }, { label: `Negative keywords (${unique.length})`, after: sample(unique) }];
    if (duplicates.length) fields.push({ label: `Skipped duplicates (${duplicates.length})`, after: sample(duplicates) });
    if (campaigns.length) fields.push({ label: `Attach to campaigns (${campaigns.length})`, after: campaigns.map(value => `${value.name} (${value.id}, ${value.status})`) });
    let details: unknown;
    return {
      summary: `Create Google negative keyword list “${input.name}” with ${plural(unique.length, 'keyword')}${campaigns.length ? ` and attach it to ${plural(campaigns.length, 'campaign')}` : ''}`,
      changes: [`+ shared_set NEGATIVE_KEYWORDS "${input.name}"`, `+ ${plural(unique.length, 'negative keyword')}: ${sample(unique).join(', ')}`, ...(duplicates.length ? [`skipped ${plural(duplicates.length, 'duplicate')}: ${sample(duplicates).join(', ')}`] : []), ...campaigns.map(value => `+ attach to campaign "${value.name}" (${value.id})`)],
      fieldChanges: [{ field: 'Negative keyword list', before: '(new)', after: input.name }, { field: 'Keywords', before: '0', after: String(unique.length) }, ...(campaigns.length ? [{ field: 'Attached campaigns', before: '0', after: String(campaigns.length) }] : [])],
      notes: notices, coercions: [], budgetDeltas: [],
      review: this.review(account, 'create', 'Create negative keyword list', input.name, fields, notices),
      resultDetails: () => details,
      execute: async validateOnly => {
        const keywordChunks = chunks(unique, chunkSize), acknowledged: string[] = [];
        if (validateOnly) {
          // Temporary resource names only resolve inside one request, so every
          // dry-run batch carries its own temporary list.
          const create = { sharedSetOperation: { create: { resourceName: temp, name: input.name, type: 'NEGATIVE_KEYWORDS' } } };
          for (const batch of keywordChunks) await this.client.googleAdsMutate(account, [create, ...batch.map(value => ({ sharedCriterionOperation: { create: criterion(temp, value) } }))], { validateOnly: true });
          if (campaigns.length) await this.client.googleAdsMutate(account, [create, ...campaigns.map(value => ({ campaignSharedSetOperation: { create: { campaign: value.resourceName, sharedSet: temp } } }))], { validateOnly: true });
          return [];
        }
        let list: string | undefined, listId: string | undefined;
        try {
          const [first, ...rest] = keywordChunks;
          const result = await this.client.googleAdsMutate(account, [{ sharedSetOperation: { create: { resourceName: temp, name: input.name, type: 'NEGATIVE_KEYWORDS' } } }, ...first!.map(value => ({ sharedCriterionOperation: { create: criterion(temp, value) } }))], { validateOnly: false });
          const responses = result.mutateOperationResponses ?? [];
          list = responses[0]?.sharedSetResult?.resourceName; listId = list?.match(new RegExp(`^customers/${account}/sharedSets/([1-9]\\d*)$`))?.[1];
          if (!listId) throw new ReceiptMismatch(first!.length + 1);
          // Record the list before checking the keyword receipts so a mismatch still names it.
          acknowledged.push(list!);
          const criterionPattern = new RegExp(`^customers/${account}/sharedCriteria/${listId}~[1-9]\\d*$`);
          if (responses.length !== first!.length + 1 || responses.slice(1).some(value => !criterionPattern.test(value.sharedCriterionResult?.resourceName ?? ''))) throw new ReceiptMismatch(first!.length);
          acknowledged.push(...responses.slice(1).map(value => value.sharedCriterionResult!.resourceName!));
          await this.batches(account, 'sharedCriteria', rest.flat().map(value => ({ create: criterion(list!, value) })), false, (_, resource) => criterionPattern.test(resource), acknowledged);
          await this.batches(account, 'campaignSharedSets', campaigns.map(value => ({ create: { campaign: value.resourceName, sharedSet: list } })), false, (operation, resource) => resource === `${String(object(operation.create).campaign).replace('/campaigns/', '/campaignSharedSets/')}~${listId}`, acknowledged);
        } catch (error) {
          throw this.outcome(error, acknowledged, 1 + unique.length + campaigns.length, listId ? `List ${listId} exists; finish with google_update_negative_keyword_list (already present keywords are skipped) and google_link_negative_keyword_list (attach) instead of creating it again.` : 'Reconcile with google_negative_keyword_lists before retrying.', listId ? { shared_set_id: listId } : {});
        }
        details = { shared_set_id: listId, keywords_added: unique.length, skipped_duplicates: duplicates.length, campaigns_attached: campaigns.map(value => value.id) };
        return acknowledged;
      },
    };
  }

  private async planUpdate(account: string, input: z.infer<typeof updateList>): Promise<Plan> {
    const list = await this.list(account, input.shared_set_id), existing = await this.criteria(account, list.id);
    const add = dedupeKeywords(input.add_keywords ?? []), remove = dedupeKeywords(input.remove_keywords ?? []);
    const removeKeys = new Set(remove.unique.map(keyOf));
    if (add.unique.some(value => removeKeys.has(keyOf(value)))) throw new AdportError('INVALID_INPUT', 'google: the same keyword cannot be both added and removed');
    const current = new Map(existing.map(value => [keyOf(value), value]));
    const additions = add.unique.filter(value => !current.has(keyOf(value))), alreadyPresent = add.unique.filter(value => current.has(keyOf(value)));
    const removals = remove.unique.flatMap(value => current.has(keyOf(value)) ? [current.get(keyOf(value))!] : []), notFound = remove.unique.filter(value => !current.has(keyOf(value)));
    if (!additions.length && !removals.length) throw new AdportError('INVALID_INPUT', `google: nothing to change; ${alreadyPresent.length} keyword(s) already in the list and ${notFound.length} removal(s) not found`);
    if (existing.length + additions.length > LIST_LIMIT) throw new AdportError('INVALID_INPUT', `google: a negative keyword list holds at most ${LIST_LIMIT} keywords (${existing.length} present, ${additions.length} new). Remove keywords in a separate call first.`);
    const operations: Row[] = [...additions.map(value => ({ create: { sharedSet: list.resource_name, keyword: { text: value.text, matchType: value.match_type } } })), ...removals.map(value => ({ remove: value.resourceName }))];
    const pattern = new RegExp(`^customers/${account}/sharedCriteria/${list.id}~[1-9]\\d*$`);
    const notices = [`Changes apply to every campaign using this list (${plural(list.reference_count, 'campaign')}) and affect their delivery immediately. Budgets, bids and statuses are unchanged.`, `Additions run before removals, in ${plural(Math.ceil(operations.length / NEGATIVE_KEYWORD_MUTATE_BATCH), 'atomic request')} of at most ${NEGATIVE_KEYWORD_MUTATE_BATCH} operations. Matching ignores case.`];
    const fields: ReviewField[] = [{ label: 'List', after: `${list.name} (${list.id})` }, { label: 'Keywords', before: existing.length, after: existing.length + additions.length - removals.length }];
    if (additions.length) fields.push({ label: `Add (${additions.length})`, after: sample(additions) });
    if (removals.length) fields.push({ label: `Remove (${removals.length})`, after: sample(removals) });
    if (alreadyPresent.length) fields.push({ label: `Skipped, already in list (${alreadyPresent.length})`, after: sample(alreadyPresent) });
    if (add.duplicates.length + remove.duplicates.length) fields.push({ label: `Skipped duplicates (${add.duplicates.length + remove.duplicates.length})`, after: sample([...add.duplicates, ...remove.duplicates]) });
    if (notFound.length) fields.push({ label: `Skipped, not in list (${notFound.length})`, after: sample(notFound) });
    let details: unknown;
    return {
      summary: `Update Google negative keyword list “${list.name}”: +${additions.length} / −${removals.length} keywords`,
      changes: [...(additions.length ? [`+ ${plural(additions.length, 'negative keyword')}: ${sample(additions).join(', ')}`] : []), ...(removals.length ? [`- ${plural(removals.length, 'negative keyword')}: ${sample(removals).join(', ')}`] : []), ...(alreadyPresent.length ? [`skipped ${alreadyPresent.length} already present: ${sample(alreadyPresent).join(', ')}`] : []), ...(notFound.length ? [`skipped ${notFound.length} not found: ${sample(notFound).join(', ')}`] : [])],
      fieldChanges: [{ field: 'Keywords', before: String(existing.length), after: String(existing.length + additions.length - removals.length) }],
      notes: notices, coercions: [], budgetDeltas: [],
      review: this.review(account, 'update', 'Update negative keyword list', list.name, fields, notices),
      resultDetails: () => details,
      execute: async validateOnly => {
        const acknowledged: string[] = [];
        try { await this.batches(account, 'sharedCriteria', operations, validateOnly, (operation, resource) => operation.remove ? resource === operation.remove : pattern.test(resource), acknowledged); }
        catch (error) { if (validateOnly) throw error; throw this.outcome(error, acknowledged, operations.length, 'Read google_negative_keyword_lists with shared_set_id and re-run the same request; keywords already present are skipped.'); }
        details = { shared_set_id: list.id, added: additions.length, removed: removals.length, skipped_already_present: alreadyPresent.length, skipped_duplicates: add.duplicates.length + remove.duplicates.length, skipped_not_found: notFound.length };
        return acknowledged;
      },
    };
  }

  private async planLink(account: string, input: z.infer<typeof linkList>, linking: boolean): Promise<Plan> {
    const list = await this.list(account, input.shared_set_id), campaigns = await this.campaigns(account, input.campaign_ids);
    const links = await this.links(account, [list.resource_name]), linked = new Map(links.map(link => [link.campaign.id, link.resource_name]));
    const targets = campaigns.filter(value => linking !== linked.has(value.id)), skipped = campaigns.filter(value => linking === linked.has(value.id));
    if (!targets.length) throw new AdportError('INVALID_INPUT', `google: every campaign is already ${linking ? 'attached to' : 'detached from'} this list`);
    const operations: Row[] = targets.map(value => linking ? { create: { campaign: value.resourceName, sharedSet: list.resource_name } } : { remove: linked.get(value.id)! });
    const verb = linking ? 'Attach' : 'Detach', describe = (value: Campaign) => `${value.name} (${value.id}, ${value.status})`;
    const notices = [linking ? `The list's ${plural(list.member_count, 'keyword')} start blocking matching searches in these campaigns immediately when they are enabled.` : 'Searches previously blocked by this list can start matching these campaigns immediately when they are enabled. The list and its keywords are preserved.', 'Budgets, bids and statuses are unchanged.'];
    const fields: ReviewField[] = [{ label: 'List', after: `${list.name} (${list.id}, ${plural(list.member_count, 'keyword')})` }, { label: `${verb} campaigns (${targets.length})`, after: targets.map(describe) }];
    if (skipped.length) fields.push({ label: `Skipped, already ${linking ? 'attached' : 'detached'} (${skipped.length})`, after: skipped.map(describe) });
    let details: unknown;
    return {
      summary: `${verb} Google negative keyword list “${list.name}” ${linking ? 'to' : 'from'} ${plural(targets.length, 'campaign')}`,
      changes: [...targets.map(value => `${linking ? '+' : '-'} campaign "${value.name}" (${value.id}) ${linking ? '←' : '↛'} list "${list.name}"`), ...(skipped.length ? [`skipped ${skipped.length} already ${linking ? 'attached' : 'detached'}`] : [])],
      fieldChanges: [{ field: 'Attached campaigns', before: String(links.length), after: String(links.length + (linking ? targets.length : -targets.length)) }],
      notes: notices, coercions: [], budgetDeltas: [],
      review: this.review(account, linking ? 'create' : 'remove', `${verb} negative keyword list`, list.name, fields, notices),
      resultDetails: () => details,
      execute: async validateOnly => {
        const acknowledged: string[] = [];
        try { await this.batches(account, 'campaignSharedSets', operations, validateOnly, (operation, resource) => resource === (operation.remove ?? `${String(object(operation.create).campaign).replace('/campaigns/', '/campaignSharedSets/')}~${list.id}`), acknowledged); }
        catch (error) { if (validateOnly) throw error; throw this.outcome(error, acknowledged, operations.length, 'Read google_negative_keyword_lists with shared_set_id and re-run the same request; finished campaigns are skipped.'); }
        details = { shared_set_id: list.id, campaigns: targets.map(value => value.id), skipped: skipped.map(value => value.id) };
        return acknowledged;
      },
    };
  }

  private async planCampaignNegatives(account: string, input: z.infer<typeof campaignNegatives>): Promise<Plan> {
    const { unique, duplicates } = dedupeKeywords(input.keywords), campaigns = await this.campaigns(account, input.campaign_ids);
    const perCampaign: Array<{ campaign: Campaign; additions: Keyword[]; present: Keyword[] }> = [];
    for (const campaign of campaigns) {
      const existing = new Set((await this.campaignNegatives(account, campaign)).map(keyOf));
      const additions = unique.filter(value => !existing.has(keyOf(value))), present = unique.filter(value => existing.has(keyOf(value)));
      if (existing.size + additions.length > CAMPAIGN_LIMIT) throw new AdportError('INVALID_INPUT', `google: campaign ${campaign.id} would exceed ${CAMPAIGN_LIMIT} negative keywords; consider a negative keyword list`);
      perCampaign.push({ campaign, additions, present });
    }
    const operations = perCampaign.flatMap(({ campaign, additions }) => additions.map(value => ({ create: { campaign: campaign.resourceName, negative: true, keyword: { text: value.text, matchType: value.match_type } } })));
    if (!operations.length) throw new AdportError('INVALID_INPUT', 'google: every keyword is already a negative keyword in every selected campaign');
    if (operations.length > OPERATION_BOUND) throw new AdportError('INVALID_INPUT', `google: ${operations.length} operations exceed the ${OPERATION_BOUND} per-call bound; split campaigns across calls or use a negative keyword list`);
    const notices = ['Campaign-level negative keywords block matching searches immediately in enabled campaigns. Budgets, bids and statuses are unchanged. For keywords shared by many campaigns, a negative keyword list is easier to maintain.', `Keywords are deduplicated by text and match type, ignoring case. Applied in ${plural(Math.ceil(operations.length / NEGATIVE_KEYWORD_MUTATE_BATCH), 'atomic request')} of at most ${NEGATIVE_KEYWORD_MUTATE_BATCH} operations.`];
    const fields: ReviewField[] = perCampaign.map(({ campaign, additions, present }) => ({ label: `${campaign.name} (${campaign.id}): +${additions.length}${present.length ? `, ${present.length} already present` : ''}`, after: additions.length ? sample(additions) : 'No change' }));
    fields.unshift({ label: 'Negative keywords to add', after: `${operations.length} across ${plural(perCampaign.filter(value => value.additions.length).length, 'campaign')}` });
    if (duplicates.length) fields.push({ label: `Skipped duplicates (${duplicates.length})`, after: sample(duplicates) });
    const pattern = new RegExp(`^customers/${account}/campaignCriteria/([1-9]\\d*)~[1-9]\\d*$`);
    let details: unknown;
    return {
      summary: `Add ${plural(operations.length, 'campaign negative keyword')} to ${plural(perCampaign.filter(value => value.additions.length).length, 'Google campaign')}`,
      changes: [...perCampaign.map(({ campaign, additions, present }) => `+ campaign "${campaign.name}" (${campaign.id}): ${additions.length ? sample(additions).join(', ') : 'no change'}${present.length ? ` (skipped ${present.length} already present)` : ''}`), ...(duplicates.length ? [`skipped ${plural(duplicates.length, 'duplicate')}: ${sample(duplicates).join(', ')}`] : [])],
      fieldChanges: perCampaign.map(({ campaign, additions, present }) => ({ field: `${campaign.name} negative keywords`, before: `${present.length} of ${unique.length} present`, after: `+${additions.length}` })),
      notes: notices, coercions: [], budgetDeltas: [],
      review: this.review(account, 'create', 'Add campaign negative keywords', `${plural(campaigns.length, 'campaign')}`, fields, notices),
      resultDetails: () => details,
      execute: async validateOnly => {
        const acknowledged: string[] = [];
        try { await this.batches(account, 'campaignCriteria', operations, validateOnly, (operation, resource) => resource.match(pattern)?.[1] === String(object(operation.create).campaign).split('/').at(-1), acknowledged); }
        catch (error) { if (validateOnly) throw error; throw this.outcome(error, acknowledged, operations.length, 'Re-run the same request; negative keywords already present are skipped.'); }
        details = { added: operations.length, campaigns: perCampaign.map(({ campaign, additions, present }) => ({ campaign_id: campaign.id, added: additions.length, skipped_already_present: present.length })), skipped_duplicates: duplicates.length };
        return acknowledged;
      },
    };
  }
}

export function googleNegativeKeywordTools(provider: GoogleAdsProvider): AnyToolDefinition[] {
  const write = (name: string, description: string, payload: z.ZodType<Row>, kind: WriteOperation['kind']) => guardedWriteTool({ name, namespace: 'google', provider: 'google', description, payload: payload as never, kind });
  const campaign = z.object({ id: z.string(), name: z.string(), status: z.string() });
  const listKeyword = z.object({ criterion_id: z.string(), text: z.string(), match_type: z.string() });
  const list = z.object({ id: z.string(), name: z.string(), member_count: z.number(), reference_count: z.number(), campaigns: z.array(campaign), keywords: z.array(listKeyword).optional(), truncated: z.boolean().optional() });
  return [
    defineTool({ name: 'google_negative_keyword_lists', namespace: 'google', description: 'Read enabled negative keyword lists with counts and attached campaigns. With shared_set_id, read that list only, including up to limit keywords.', input: z.object({ account_id: z.string(), shared_set_id: id.optional(), limit: z.number().int().positive().max(LIST_LIMIT).optional() }), output: z.object({ lists: z.array(list) }), annotations: { readOnly: true }, handler: input => provider.negativeKeywords.listLists(input) }),
    write('google_create_negative_keyword_list', 'Create a negative keyword list (up to 5,000 keywords), optionally attached to campaigns.', createList, 'create'),
    write('google_update_negative_keyword_list', 'Add or remove keywords in a negative keyword list. Affects every attached campaign.', updateList, 'update'),
    // One tool for both directions, like other grant/revoke writes: kind is update.
    write('google_link_negative_keyword_list', 'Attach or detach a negative keyword list for one or many campaigns. Detaching keeps the list.', linkList, 'update'),
    write('google_add_campaign_negative_keywords', 'Add the same campaign-level negative keywords to one or many campaigns.', campaignNegatives, 'create'),
  ];
}

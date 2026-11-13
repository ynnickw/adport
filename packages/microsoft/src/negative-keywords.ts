import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const target = z.discriminatedUnion('type', [z.object({ type: z.literal('Campaign'), campaign_id: id }), z.object({ type: z.literal('AdGroup'), campaign_id: id, ad_group_id: id })]);
const keyword = z.object({ text: z.string().min(1).max(100).refine(value => value.trim().length > 0, 'Keyword text cannot be blank'), match_type: z.enum(['Exact', 'Phrase']) });
const add = z.object({ target, keywords: z.array(keyword).min(1).max(1000) }).refine(value => new Set(value.keywords.map(value => JSON.stringify([value.text, value.match_type]))).size === value.keywords.length, 'Negative keywords must be unique');
const remove = z.object({ target, keyword_ids: z.array(id).min(1).max(1000).refine(value => new Set(value).size === value.length, 'Keyword IDs must be unique') });
type Target = z.infer<typeof target>;
type Entity = { EntityId: string; EntityType: 'Campaign' | 'AdGroup'; ParentEntityId: string | null };
export const MICROSOFT_NEGATIVE_KEYWORD_WRITES = new Set(['microsoft_add_negative_keywords', 'microsoft_remove_negative_keywords']);

/** MicrosoftDocs/Advertising@fdee2fcf; campaign empty-list envelope also live-verified. */
export class MicrosoftNegativeKeywordService extends MicrosoftNativeService {
  private async entity(account: string, value: Target): Promise<Entity> {
    await this.campaign(account, value.campaign_id);
    if (value.type === 'Campaign') return { EntityId: value.campaign_id, EntityType: 'Campaign', ParentEntityId: null };
    const result = await this.request(account, 'AdGroups/QueryByIds', { CampaignId: value.campaign_id, AdGroupIds: [value.ad_group_id] });
    const groups = rows(result.AdGroups);
    if (groups.length !== 1 || nativeId(groups[0]!.Id) !== value.ad_group_id) throw new AdportError('INVALID_INPUT', 'microsoft: ad group was not found in the selected campaign/account');
    return { EntityId: value.ad_group_id, EntityType: 'AdGroup', ParentEntityId: value.campaign_id };
  }

  private async query(account: string, entity: Entity) {
    const result = await this.request(account, 'NegativeKeywords/QueryByEntityIds', { EntityIds: [entity.EntityId], EntityType: entity.EntityType, ParentEntityId: entity.ParentEntityId });
    const collections = rows(result.EntityNegativeKeywords);
    if (collections.length !== 1 || nativeId(collections[0]!.EntityId) !== entity.EntityId || collections[0]!.EntityType !== entity.EntityType || !Object.hasOwn(collections[0]!, 'NegativeKeywords')) throw new AdportError('PROVIDER_ERROR', 'microsoft: negative-keyword entity identity mismatch');
    const values = rows(collections[0]!.NegativeKeywords);
    if (values.length > 20_000 || new Set(values.map(value => nativeId(value.Id))).size !== values.length || values.some(value => !keyword.safeParse({ text: value.Text, match_type: value.MatchType }).success)) throw new AdportError('PROVIDER_ERROR', 'microsoft: invalid native negative-keyword list');
    return values;
  }

  async list(input: { account_id: string; target: Target; after_keyword_id?: string; limit: number }) {
    const entity = await this.entity(input.account_id, input.target), values = await this.query(input.account_id, entity);
    const remaining = values.filter(value => !input.after_keyword_id || BigInt(nativeId(value.Id)) > BigInt(input.after_keyword_id)).sort((a, b) => BigInt(nativeId(a.Id)) < BigInt(nativeId(b.Id)) ? -1 : BigInt(nativeId(a.Id)) > BigInt(nativeId(b.Id)) ? 1 : 0);
    const page = remaining.slice(0, input.limit), truncated = remaining.length > page.length;
    return { rows: page, truncated, ...(truncated ? { next_cursor: nativeId(page.at(-1)!.Id) } : {}) };
  }

  async plan(op: WriteOperation): Promise<MicrosoftPlan> {
    if (op.provider !== 'microsoft' || !MICROSOFT_NEGATIVE_KEYWORD_WRITES.has(op.tool) || op.kind !== (op.tool === 'microsoft_add_negative_keywords' ? 'create' : 'remove')) throw new AdportError('INVALID_INPUT', 'microsoft: negative-keyword operation kind mismatch');
    const input = op.tool === 'microsoft_add_negative_keywords' ? add.parse(op.payload) : remove.parse(op.payload), entity = await this.entity(op.accountId, input.target), current = await this.query(op.accountId, entity);
    if ('keywords' in input) {
      const existing = new Set(current.map(value => JSON.stringify([value.Text, value.MatchType])));
      if (input.keywords.some(value => existing.has(JSON.stringify([value.text, value.match_type])))) throw new AdportError('INVALID_INPUT', 'microsoft: an exact negative-keyword entry already exists; do not replay the create operation');
      if (current.length + input.keywords.length > 20_000) throw new AdportError('INVALID_INPUT', 'microsoft: this request exceeds the native 20000 direct-negative-keyword limit');
      const values = input.keywords.map(value => ({ Text: value.text, MatchType: value.match_type }));
      return { summary: `Add ${values.length} Microsoft ${entity.EntityType} negative keyword(s)`, changes: [`+ exclusions ${JSON.stringify(values)} in ${entity.EntityType} ${entity.EntityId}`, 'Appends direct exclusions. Native negative keywords have no individual serving status; parent status is preserved. Shared and inherited exclusions are separate.'], coercions: [], budgetDeltas: [], execute: async () => {
        const result = await this.request(op.accountId, 'EntityNegativeKeywords', { EntityNegativeKeywords: [{ EntityId: entity.EntityId, EntityType: entity.EntityType, NegativeKeywords: values }] });
        const groups = rows(result.NegativeKeywordIds), ids = groups.length === 1 && Array.isArray(groups[0]!.Ids) ? groups[0]!.Ids.filter(value => value !== null).map(nativeId) : [];
        if (ids.length !== values.length || new Set(ids).size !== ids.length || ids.some(id => current.some(value => nativeId(value.Id) === id))) throw new AdportError('PROVIDER_ERROR', 'microsoft: negative-keyword creation receipt mismatch; reconcile before retrying', { resourceIds: ids });
        try {
          const actual = await this.query(op.accountId, entity);
          if (ids.some((id, index) => !actual.some(value => nativeId(value.Id) === id && value.Text === values[index]!.Text && value.MatchType === values[index]!.MatchType))) throw new Error('Created exclusion was not confirmed');
        } catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: negative keywords were accepted but content readback was not confirmed; reconcile before retrying', { resourceIds: ids }); }
        return ids;
      } };
    }
    const selected = input.keyword_ids.map(id => current.find(value => nativeId(value.Id) === id));
    if (selected.some(value => !value)) throw new AdportError('INVALID_INPUT', 'microsoft: a negative keyword was not found in the selected entity/account');
    return { summary: `Remove ${selected.length} Microsoft ${entity.EntityType} negative keyword(s)`, changes: [`- direct exclusions ${JSON.stringify(selected)}`, 'Removing exclusions can broaden delivery. Other direct, inherited and shared-list exclusions and parent serving statuses are preserved.'], coercions: [], budgetDeltas: [], execute: async () => {
      await this.request(op.accountId, 'EntityNegativeKeywords', { EntityNegativeKeywords: [{ EntityId: entity.EntityId, EntityType: entity.EntityType, NegativeKeywords: input.keyword_ids.map(Id => ({ Id })) }] }, 'DELETE');
      try {
        if ((await this.query(op.accountId, entity)).some(value => input.keyword_ids.includes(nativeId(value.Id)))) throw new Error('Deleted exclusion remains');
      } catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: negative-keyword removal was not confirmed; reconcile before retrying', { resourceIds: input.keyword_ids }); }
      return input.keyword_ids;
    } };
  }
}

export function microsoftNegativeKeywordTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_negative_keywords', namespace: 'microsoft', description: 'Read direct campaign or ad-group negative keywords after verifying the full account/parent hierarchy. Shared-list and inherited exclusions are separate. Continue with next_cursor as after_keyword_id.', input: z.object({ account_id: id, target, after_keyword_id: id.optional(), limit: z.number().int().positive().max(1000).default(100) }), output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_keyword_id' }, annotations: { readOnly: true }, handler: input => provider.negativeKeywords.list(input) }),
    guardedWriteTool({ name: 'microsoft_add_negative_keywords', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Append up to 1000 direct Exact/Phrase exclusions to an owned campaign or ad group. Native negative keywords have no pause state and only restrict delivery; parent status is preserved. Verifies every created ID and its text/match type.', payload: add }),
    guardedWriteTool({ name: 'microsoft_remove_negative_keywords', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', description: 'Remove exact owned direct exclusion IDs. This can broaden delivery. Text and match type are immutable: add and confirm a replacement before removing its predecessor. Shared and inherited exclusions are separate.', payload: remove }),
  ];
}

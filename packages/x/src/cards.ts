import { createHash } from 'node:crypto';
import { AdportError, type Creative, type ReviewField, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { cardButtonLabel, cardComponents, cardSlides, cardWrites, createCard, deleteCard, listCards, nativeCard, updateCard, type CardLayout, type NativeCard } from './card-schemas.js';
import type { XParams } from './client.js';
import { snowflake } from './creative-tools.js';
import type { XCreativeService } from './creatives.js';
import type { XAdsEntities } from './entities.js';
import { xId } from './schemas.js';
import type { XWritePlan } from './writes.js';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const layoutOf = (card: NativeCard) => ({ ...(card.components?.length ? { components: card.components } : {}), ...(card.slides?.length ? { slides: card.slides } : {}) });
const content = (card: NativeCard) => ({ id: card.id, card_uri: card.card_uri, name: card.name, card_type: card.card_type, deleted: card.deleted, ...layoutOf(card) });
const mutationNotice = 'Shared card edits or deletion can affect existing posts and ads. This operation does not publish a post, create an ad association or change delivery/budgets. Native content validation happens only on apply. No native write is retried automatically.';
type Media = Awaited<ReturnType<XCreativeService['media']>>;

export class XCardService {
  constructor(private readonly entities: XAdsEntities, private readonly creatives: XCreativeService) {}
  private hash(account: string, card: NativeCard) { return createHash('sha256').update(JSON.stringify(canonical({ account_id: account, card }))).digest('hex'); }
  private decorate(account: string, card: NativeCard) { return { ...card, configuration_hash: this.hash(account, card) }; }
  private async owned(account: string, id: string, withDeleted = false) {
    await this.entities.getAccount(account);
    const result = await this.entities.client.request('GET', `accounts/${xId.parse(account)}/cards/${snowflake.parse(id)}`, z.object({ data: z.array(nativeCard).max(1) }), { with_deleted: withDeleted });
    const card = result.data[0];
    if (!card || card.id !== id || !withDeleted && card.deleted || card.account_id !== undefined && card.account_id !== account) throw new AdportError('PROVIDER_ERROR', 'x: card ID, account or deletion state mismatch');
    return card;
  }
  async get(account: string, id: string, withDeleted = false) { return this.decorate(account, await this.owned(account, id, withDeleted)); }
  private keys(layout: CardLayout) { return [...new Set((layout.components ? [layout.components] : layout.slides ?? []).flatMap(row => row.flatMap(v => v.type === 'MEDIA' ? [v.media_key] : v.type === 'SWIPEABLE_MEDIA' ? v.media_keys : [])))]; }
  private supportedLayout(card: NativeCard): CardLayout {
    const value = layoutOf(card);
    if (!!value.components === !!value.slides) throw new AdportError('INVALID_INPUT', 'x: current card layout is not representable by this authoring tool; no fields were discarded');
    if (value.components) { const parsed = cardComponents.safeParse(value.components);if (parsed.success) return { components: parsed.data }; }
    if (value.slides) { const parsed = cardSlides.safeParse(value.slides);if (parsed.success) return { slides: parsed.data }; }
    throw new AdportError('INVALID_INPUT', 'x: current card contains unsupported component fields; replace the complete layout explicitly or change only its name');
  }
  private async mediaFor(account: string, layout: CardLayout) {
    const sources = new Map<string, Media>();
    for (const key of this.keys(layout)) {
      const value = await this.creatives.media(account, key);
      if (value.deleted || value.media_status !== 'TRANSCODE_COMPLETED' || !['IMAGE', 'VIDEO'].includes(value.media_type) || value.account_id !== undefined && value.account_id !== account) throw new AdportError('INVALID_INPUT', 'x: every card attachment must be a ready image or video in the selected account library');
      sources.set(key, value);
    }
    return sources;
  }
  private cardType(layout: CardLayout, media: Map<string, Media>) {
    const kinds = new Set([...media.values()].map(v => v.media_type)), kind = kinds.size > 1 ? 'MIXED_MEDIA' : [...kinds][0];
    if (layout.slides) return `${kind}_MULTI_DEST_CAROUSEL_WEBSITE`;
    const [asset, description] = layout.components!, destination = description!.type === 'DETAILS' ? 'WEBSITE' : 'APP';
    return asset!.type === 'MEDIA' ? `${kind}_${destination}` : `${kind}${kind === 'MIXED_MEDIA' ? '_SINGLE_DEST' : ''}_CAROUSEL_${destination}`;
  }
  private copyLayout(card: NativeCard, input: z.infer<typeof updateCard>) {
    const layout = this.supportedLayout(card);
    if (layout.slides && input.slide_index === undefined) throw new AdportError('INVALID_INPUT', 'x: select slide_index for a multi-destination copy edit');
    if (layout.components && input.slide_index !== undefined) throw new AdportError('INVALID_INPUT', 'x: slide_index is only valid for a multi-destination card');
    const row = layout.components ?? layout.slides?.[input.slide_index!];
    if (!row) throw new AdportError('INVALID_INPUT', 'x: selected slide is not present in this card');
    const description = row[1]!;
    if (input.title !== undefined || input.website_url !== undefined) {
      if (description.type !== 'DETAILS') throw new AdportError('INVALID_INPUT', 'x: title/website_url shortcuts require website DETAILS');
      if (input.title !== undefined) description.title = input.title;
      if (input.website_url !== undefined) description.destination.url = input.website_url;
    }
    if (input.button_label !== undefined) {
      if (description.type !== 'BUTTON') throw new AdportError('INVALID_INPUT', 'x: button_label requires an app BUTTON');
      description.label.value = input.button_label;
    }
    return layout;
  }
  private actions(account: string, card: NativeCard): Creative['actions'] {
    if (card.deleted || !snowflake.safeParse(card.id).success || !card.name) return [];
    const args = { account_id: account, card_id: card.id, expected_configuration_hash: this.hash(account, card), acknowledge_shared_creative_effects: true };
    const actions: Creative['actions'] = [{ label: 'Rename card', tool: 'x_update_card', arguments: args, fields: [{ key: 'name', label: 'Card name', type: 'text', value: card.name, max_length: 80 }] }];
    let layout: CardLayout;try { layout = this.supportedLayout(card); } catch { return actions; }
    for (const [index, row] of (layout.components ? [layout.components] : layout.slides!).entries()) {
      const description = row[1]!, bound = { ...args, ...(layout.slides ? { slide_index: index } : {}) };
      if (description.type === 'DETAILS') actions.push({ label: layout.slides ? `Edit slide ${index + 1} copy` : 'Edit card copy', tool: 'x_update_card', arguments: bound, fields: [{ key: 'title', label: 'Title', type: 'text', value: description.title }, { key: 'website_url', label: 'Website URL', type: 'text', value: description.destination.url }] });
      if (description.type === 'BUTTON') actions.push({ label: 'Edit app button', tool: 'x_update_card', arguments: bound, fields: [{ key: 'button_label', label: 'Button', type: 'select', value: description.label.value, options: cardButtonLabel.options.map(value => ({ label: value, value })) }] });
    }
    return actions;
  }
  async list(value: z.input<typeof listCards>) {
    const input = listCards.parse(value);await this.entities.getAccount(input.account_id);
    const params: XParams = { count: input.count, include_legacy_cards: input.include_legacy_cards, with_deleted: input.with_deleted, ...(input.cursor ? { cursor: input.cursor } : {}), ...(input.q ? { q: input.q } : {}), ...(input.card_types ? { card_types: input.card_types.join(',') } : {}), ...(input.card_ids ? { card_id: input.card_ids.join(',') } : {}), ...(input.card_uris ? { card_uris: input.card_uris.join(',') } : {}) };
    const result = await this.entities.client.request('GET', `accounts/${input.account_id}/cards`, z.object({ data: z.array(nativeCard).max(1000), next_cursor: z.string().max(4096).nullish() }), params);
    if (new Set(result.data.map(v => v.id)).size !== result.data.length || new Set(result.data.map(v => v.card_uri)).size !== result.data.length || result.next_cursor && result.next_cursor === input.cursor || result.data.some(v => !input.with_deleted && v.deleted || v.account_id !== undefined && v.account_id !== input.account_id || input.card_ids && !input.card_ids.includes(v.id) || input.card_uris && !input.card_uris.includes(v.card_uri) || input.card_types && !input.card_types.some(t => t === v.card_type))) throw new AdportError('PROVIDER_ERROR', 'x: card inventory repeated a resource/cursor or returned a conflicting account/filter');
    const warnings: string[] = [], media = new Map<string, Media>(), keys: string[] = [];
    for (const card of result.data) { try { keys.push(...this.keys(this.supportedLayout(card))); } catch { warnings.push(`Card ${card.id} has a layout that cannot be hydrated by this tool; native content is retained in items.`); } }
    const unique = [...new Set(keys)];let offset = 0;
    if (input.include_media) await Promise.all(Array.from({ length: Math.min(4, unique.length, 100) }, async () => { while (offset < Math.min(unique.length, 100)) { const key = unique[offset++]!;try { const source = await this.creatives.media(input.account_id, key);if (!source.deleted && (source.account_id === undefined || source.account_id === input.account_id)) media.set(key, source);else warnings.push(`Media ${key} is deleted or unavailable in this account.`); } catch { warnings.push(`Media ${key} could not be read from this account.`); } } }));
    if (input.include_media && unique.length > 100) warnings.push('Preview hydration is limited to 100 distinct media; native card references are retained in items.');
    const creatives: Creative[] = result.data.map(card => {
      let layout: CardLayout | undefined;try { layout = this.supportedLayout(card); } catch {}
      const rows = layout?.components ? [layout.components] : layout?.slides ?? [], descriptions = rows.map(v => v[1]!), headlines = descriptions.flatMap(v => v.type === 'DETAILS' ? [v.title] : []), urls = descriptions.flatMap(v => v.type === 'DETAILS' ? [v.destination.url] : []);
      return { id: card.id, provider: 'x', account_id: input.account_id, name: card.name ?? card.id, type: card.card_type, status: card.deleted ? 'DELETED' : 'CARD', headlines, descriptions: descriptions.flatMap(v => v.type === 'BUTTON' ? [v.label.value] : []), landing_urls: urls, media: input.include_media && layout ? this.keys(layout).flatMap(key => media.has(key) ? this.creatives.visual(media.get(key)!) : []) : [], actions: this.actions(input.account_id, card) };
    });
    return { items: result.data.map(v => this.decorate(input.account_id, v)), creatives, warnings, truncated: Boolean(result.next_cursor), ...(result.next_cursor ? { next_cursor: result.next_cursor } : {}) };
  }
  private layoutFields(layout: CardLayout): Record<string, unknown> {
    const fields: Record<string, unknown> = { Media: this.keys(layout) };
    for (const [index, row] of (layout.components ? [layout.components] : layout.slides ?? []).entries()) {
      const prefix = layout.slides ? `Slide ${index + 1} ` : '', description = row[1]!;
      if (description.type === 'DETAILS') { fields[`${prefix}title`] = description.title;fields[`${prefix}website`] = description.destination.url; }
      if (description.type === 'BUTTON') { fields.Button = description.label.value;fields['App destination'] = description.destination; }
    }
    return fields;
  }
  async plan(op: WriteOperation): Promise<XWritePlan> {
    const creating = op.tool === 'x_create_card', removing = op.tool === 'x_delete_card', account = xId.parse(op.accountId);
    if (op.provider !== 'x' || !cardWrites.has(op.tool) || op.kind !== (creating ? 'create' : removing ? 'remove' : 'update')) throw new AdportError('INVALID_INPUT', 'x: card operation provider/kind mismatch');
    const input = creating ? createCard.parse(op.payload) : removing ? deleteCard.parse(op.payload) : updateCard.parse(op.payload);
    await this.entities.getAccount(account);
    const current = 'card_id' in input ? await this.owned(account, input.card_id) : undefined;
    if (current && 'expected_configuration_hash' in input && this.hash(account, current) !== input.expected_configuration_hash) throw new AdportError('PENDING_MISMATCH', 'x: card configuration changed; read x_get_card before requesting a new preview');
    let body: Record<string, unknown> = {}, expected: ReturnType<typeof content> | undefined, layout: CardLayout | undefined;
    if (!removing) {
      if (creating) { const v = createCard.parse(input);body = v;layout = v; }
      else {
        const v = updateCard.parse(input);body = { ...(v.name !== undefined ? { name: v.name } : {}) };
        layout = v.components ? { components: v.components } : v.slides ? { slides: v.slides } : v.title !== undefined || v.website_url !== undefined || v.button_label !== undefined ? this.copyLayout(current!, v) : undefined;
        if (layout) body = { ...body, ...layout };
      }
      const sources = layout ? await this.mediaFor(account, layout) : undefined;
      expected = { ...(current ? content(current) : { id: '', card_uri: '', deleted: false }), name: typeof body.name === 'string' ? body.name : current!.name, card_type: layout ? this.cardType(layout, sources!) : current!.card_type, ...(layout ?? layoutOf(current!)) };
      if (layout?.components) delete expected.slides;
      if (layout?.slides) delete expected.components;
    }
    const title = `${creating ? 'Create' : removing ? 'Delete' : 'Edit'} X card`, name = typeof body.name === 'string' ? body.name : current!.name ?? current!.id;
    const fields: ReviewField[] = [{ label: 'Card name', ...(current ? { before: current.name ?? current.id } : {}), after: removing ? null : name }, ...(current ? [{ label: 'Card ID', after: current.id }] : [])];
    if (removing) fields.push({ label: 'Deleted', before: false, after: true });
    if (layout) {
      let previous: Record<string, unknown> = {};try { if (current) previous = this.layoutFields(this.supportedLayout(current)); } catch {}
      const proposed = this.layoutFields(layout);
      fields.push({ label: 'Card type', ...(current ? { before: current.card_type } : {}), after: expected!.card_type });
      for (const key of new Set([...Object.keys(previous), ...Object.keys(proposed)])) if (!current || !equal(previous[key], proposed[key])) fields.push({ label: key, ...(current ? { before: previous[key] } : {}), after: proposed[key] ?? null });
    }
    return { summary: `${title} "${name}"`, changes: [removing ? `- Delete card ${current!.id} (${current!.card_uri}). No restore endpoint is established.` : `${creating ? '+' : '~'} ${JSON.stringify(body)}`, mutationNotice], notes: [creating ? 'Creates an unattached card only. No post is published and no ad association is created.' : mutationNotice], coercions: [], budgetDeltas: [],
      review: { provider: 'x', accountId: account, kind: creating ? 'create' : removing ? 'remove' : 'update', title, fields, notices: [mutationNotice] },
      execute: async () => {
        let knownId = current?.id;
        try {
          const base = `accounts/${account}/cards`;
          const receipt = creating
            ? (await this.entities.client.request('POST', base, z.object({ data: nativeCard }), {}, body)).data
            : (await this.entities.client.request(removing ? 'DELETE' : 'PUT', `${base}/${current!.id}`, z.object({ data: z.array(nativeCard).length(1) }), {}, removing ? undefined : body)).data[0]!;
          knownId = receipt.id;
          if (current && (receipt.id !== current.id || receipt.card_uri !== current.card_uri)) throw new Error('x: card mutation receipt identity mismatch');
          if (removing ? !receipt.deleted : !equal(content(receipt), { ...expected, id: receipt.id, card_uri: receipt.card_uri })) throw new Error('x: card mutation receipt differs from the approved content');
          const observed = await this.owned(account, receipt.id, removing);
          if (observed.card_uri !== receipt.card_uri || (removing ? !observed.deleted : !equal(content(observed), { ...expected, id: receipt.id, card_uri: receipt.card_uri }))) throw new Error('x: independent card readback differs from the approved content');
          return [receipt.id];
        } catch (error) {
          const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
          const previous = Array.isArray(details.resource_ids) ? details.resource_ids.filter((v): v is string => typeof v === 'string') : [];
          throw new AdportError('PROVIDER_ERROR', `${error instanceof Error ? error.message : 'x: card mutation was not confirmed'}. Reconcile the original card IDs before another mutation; no write was retried.`, { ...details, resource_ids: [...new Set([...(current ? [current.id] : []), ...(knownId ? [knownId] : []), ...previous])] });
        }
      } };
  }
}

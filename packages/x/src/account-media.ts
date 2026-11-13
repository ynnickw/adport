import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import { accountMediaUsage, deleteAccountMedia } from './account-media-schemas.js';
import { nativeAccountMedia, nativeDirectMedia } from './direct-media-schemas.js';
import type { XDirectMediaService } from './direct-media.js';
import type { XAdsEntities } from './entities.js';
import { xId } from './schemas.js';

type Association = z.infer<typeof nativeDirectMedia>;
const page = z.object({ data: z.array(nativeDirectMedia).max(1000), next_cursor: z.string().nullable().optional() });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const configuration = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['created_at', 'updated_at', 'account_id', 'configuration_hash'].includes(key)));
const reference = (row: Association) => ({ id: row.id, line_item_id: row.line_item_id, account_media_id: row.account_media_id, creative_type: row.creative_type, landing_url: row.landing_url ?? null, entity_status: row.entity_status, deleted: row.deleted });

/** Native v12 Account Media DELETE and account-wide media_creatives GET, refreshed2026-11-06. */
export class XAccountMediaService {
  constructor(private readonly entities: XAdsEntities, private readonly media: XDirectMediaService) {}
  private async references(account: string, source: string) {
    const references: Association[] = [], ids = new Set<string>(), cursors = new Set<string>();let cursor: string | undefined;
    // No documented source-ID filter exists. Include tombstones and deleted-parent
    // associations; a partial scan must never authorize source deletion.
    for (let index = 0; index < 10; index++) {
      const result = await this.entities.client.request('GET', `accounts/${account}/media_creatives`, page, { count: 1000, with_deleted: true, ...(cursor ? { cursor } : {}) });
      for (const row of result.data) {
        if (row.account_id !== undefined && row.account_id !== account || ids.has(row.id)) throw new AdportError('PROVIDER_ERROR', 'x: Account Media usage scan returned a different account or repeated association');
        ids.add(row.id);if (row.account_media_id === source) references.push(row);
      }
      if (result.next_cursor === null) return { references: references.sort((a, b) => a.id.localeCompare(b.id)), scanned_associations: ids.size };
      if (!result.next_cursor || cursors.has(result.next_cursor)) break;
      cursors.add(result.next_cursor);cursor = result.next_cursor;
    }
    throw new AdportError('PROVIDER_ERROR', 'x: Account Media usage is incomplete; no source deletion is permitted. Reconcile the account inventory before trying again.');
  }
  private async context(account: string, id: string) {
    xId.parse(account);xId.parse(id);
    const asset = await this.media.getAsset(account, id), inventory = await this.references(account, id), references = inventory.references.map(reference), active = references.filter(row => !row.deleted);
    const context_hash = hash({ account_id: account, source: configuration(asset), references }), can_delete = !asset.deleted && active.length === 0, creative = this.media.assetCard(account, asset);
    if (can_delete) creative.actions = [{ label: 'Delete asset', tool: 'x_delete_account_media', arguments: { account_id: account, account_media_id: id, expected_context_hash: context_hash, acknowledge_source_deletion: true }, fields: [] }];
    const notes = ['Account Media is a native source asset, distinct from media-library keys, upload receipts and Adport project files.', 'Detach every non-deleted media_creative reference before source deletion, including references under deleted or paused parents. Each disassociation has its own preview/apply approval.', 'The complete bounded account-wide association scan is a snapshot, not an atomic native lock. Reconcile unknown outcomes; no mutation is retried.'];
    return { asset, references, non_deleted_references: active.length, can_delete, context_hash, scanned_associations: inventory.scanned_associations, truncated: false, creatives: [creative], notes };
  }
  async usage(account: string, id: string, options: { reference_offset?: number; reference_limit?: number; expected_context_hash?: string } = {}) {
    const input = accountMediaUsage.parse({ ...options, account_id: account, account_media_id: id }), context = await this.context(account, id);
    if (input.expected_context_hash !== undefined && input.expected_context_hash !== context.context_hash) throw new AdportError('PENDING_MISMATCH', 'x: Account Media reference pages changed; inspect usage again from the first page');
    const end = input.reference_offset + input.reference_limit;
    return { ...context, references: context.references.slice(input.reference_offset, end), reference_total: context.references.length, reference_offset: input.reference_offset, usage_complete: true, references_truncated: end < context.references.length, ...(end < context.references.length ? { next_reference_offset: end } : {}) };
  }
  async plan(op: WriteOperation): Promise<Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> }> {
    if (op.provider !== 'x' || op.kind !== 'remove' || op.tool !== 'x_delete_account_media') throw new AdportError('INVALID_INPUT', 'x: unsupported Account Media source operation');
    const account = xId.parse(op.accountId), input = deleteAccountMedia.parse(op.payload), context = await this.context(account, input.account_media_id);
    if (context.asset.deleted || context.context_hash !== input.expected_context_hash) throw new AdportError('PENDING_MISMATCH', 'x: Account Media source or usage changed; inspect usage and preview again');
    if (!context.can_delete) throw new AdportError('INVALID_INPUT', 'x: Account Media still has non-deleted ad associations. Review and detach each association before deleting its source.');
    const fields = [{ label: 'Account Media', after: context.asset.id }, { label: 'Format', after: context.asset.creative_type }, { label: 'Non-deleted ad associations', after: 0 }, { label: 'Deleted', before: false, after: true }];
    const notes = [...context.notes, 'Deletes this one Account Media source. No media-library/project-file deletion, ad disassociation, parent status/budget change or publication request is sent. This is source deletion, not a reversible ad pause.'];
    return { summary: `Delete Account Media ${context.asset.id}`, changes: fields.map(field => `${field.label}: ${JSON.stringify(field.after)}`), coercions: [], budgetDeltas: [], notes, review: { provider: 'x', accountId: account, kind: 'remove', title: 'Delete Account Media', fields, notices: notes }, execute: async () => {
      const known = [context.asset.id];
      try {
        const row = (await this.entities.client.request('DELETE', `accounts/${account}/account_media/${context.asset.id}`, z.object({ data: nativeAccountMedia }))).data;known.push(row.id);
        if (row.account_id !== undefined && row.account_id !== account || hash(configuration(row)) !== hash(configuration({ ...context.asset, deleted: true }))) throw new Error('Source deletion receipt differs');
        const after = await this.context(account, context.asset.id);
        if (hash(configuration(after.asset)) !== hash(configuration(row)) || hash(after.references) !== hash(context.references)) throw new Error('Source deletion readback or references differ');
        return [context.asset.id];
      } catch (error) {
        const prior = error instanceof AdportError && error.details && typeof error.details === 'object' && 'resource_ids' in error.details && Array.isArray(error.details.resource_ids) ? error.details.resource_ids.filter((id): id is string => typeof id === 'string' && xId.safeParse(id).success) : [];
        throw new AdportError('PROVIDER_ERROR', 'x: Account Media source deletion was not confirmed. Inspect the known source ID and association inventory before another mutation; no DELETE was retried.', { resource_ids: [...new Set([...known, ...prior])] });
      }
    } };
  }
}

import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview } from '@adport/core';
import { z } from 'zod';
import type { TikTokClient } from './client.js';
import { migrationScope, requireCatalogMigrationAccess, type TikTokCatalogAccessStore } from './catalog-access.js';
import { catalogInput } from './catalog-schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogMigration = catalogInput.omit({ account_id: true }).extend({
  expected_migration_access_hash: hash, expected_destination_hash: hash,
  confirm_catalog_id: z.string(), acknowledge_shared_effects: z.literal(true),
  acknowledge_source_ownership_not_independently_verified: z.literal(true),
}).strict().refine(input => input.confirm_catalog_id === input.catalog_id, 'Confirm the exact source catalog ID');
type Scope = z.infer<typeof catalogInput>;
type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<string[]> };
const notes = [
  'Source ownership is attested by the project owner, not independently verified by an Adport source lookup. TikTok enforces source-advertiser ownership when applying the transfer.',
  'The destination Business Center Admin role is read from TikTok at preview and apply. The source catalog must not already be present there.',
  'Transfers the entire catalog, including its products, product sets and video templates. Existing users, ads and shared consumers may be affected; dependent contents are not enumerated or frozen.',
  'No ads are activated and no budgets or tracking events are changed. Native ownership transfer has no automatic retry or rollback.',
  'After transfer, the owner must separately grant read/write access to the exact destination catalog. Existing project grants are not expanded.',
];

export class TikTokCatalogMigration {
  constructor(private readonly client: Pick<TikTokClient, 'get' | 'post'>, private readonly store: TikTokCatalogAccessStore | undefined, private readonly lookup: (input: Scope) => Promise<unknown | undefined>) {}

  async destination(bcId: string) {
    let response: unknown;
    try { response = await this.client.get('bc/get', { bc_id: bcId, page: 1, page_size: 1 }); }
    catch { throw new AdportError('PROVIDER_ERROR', 'TikTok destination Business Center lookup failed. Check the current token’s Business Center permission and exact ID. No transfer was submitted.'); }
    const parsed = z.looseObject({
      list: z.array(z.looseObject({ bc_info: z.looseObject({ bc_id: z.string(), name: z.string().optional() }), user_role: z.string() })).length(1),
      page_info: z.looseObject({ page: z.literal(1), total_page: z.number().int().min(0).max(1), total_number: z.number().int().min(0).max(1).optional() }).optional(),
    }).safeParse(response);
    if (!parsed.success || parsed.data.list[0]!.bc_info.bc_id !== bcId || parsed.data.list[0]!.user_role !== 'ADMIN' || parsed.data.page_info?.total_number === 0) throw new AdportError('POLICY_VIOLATION', 'The exact destination Business Center and native Admin role could not be verified.');
    const selected = parsed.data.list[0]!;
    return { bc_id: bcId, name: selected.bc_info.name ?? bcId, user_role: selected.user_role };
  }

  async context(raw: unknown) {
    const input = catalogInput.parse(raw), grant = await requireCatalogMigrationAccess(this.store, migrationScope(input.account_id, input.bc_id, input.catalog_id));
    const destination = await this.destination(input.bc_id);
    if (await this.lookup(input)) throw new AdportError('INVALID_INPUT', 'This catalog is already in the destination Business Center. Do not transfer it again; review its exact catalog access separately.');
    return { expected_migration_access_hash: grant.hash, expected_destination_hash: createHash('sha256').update(JSON.stringify({ ...input, destination })).digest('hex'),
      source_ownership: 'OWNER_ATTESTED_NOT_INDEPENDENTLY_VERIFIED' as const, destination,
      records: [{ id: input.catalog_id, name: 'Catalog transfer', source_advertiser_id: input.account_id, destination_business_center_id: input.bc_id, source_ownership: 'Owner attested', destination_role: destination.user_role }], notes: [...notes] };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.provider !== 'tiktok' || op.tool !== 'tiktok_migrate_catalog' || op.kind !== 'update') throw new AdportError('INVALID_INPUT', 'Unsupported catalog migration operation.');
    const input = catalogMigration.parse(op.payload), selection = { account_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id };
    const prepare = async () => {
      await requireCatalogMigrationAccess(this.store, migrationScope(op.accountId, input.bc_id, input.catalog_id), true);
      const current = await this.context(selection);
      if (current.expected_migration_access_hash !== input.expected_migration_access_hash || current.expected_destination_hash !== input.expected_destination_hash) throw new AdportError('PENDING_MISMATCH', 'Transfer delegation or destination changed. Read migration context and review a new preview.');
      return current;
    };
    const current = await prepare();
    return { summary: `Transfer TikTok catalog ${input.catalog_id} to ${current.destination.name}`, changes: [`~ Entire catalog ${input.catalog_id}: advertiser ${op.accountId} → Business Center ${input.bc_id}`], coercions: [], budgetDeltas: [], notes: [...notes],
      review: { provider: 'tiktok', accountId: op.accountId, kind: 'update', title: 'Transfer catalog ownership', subject: input.catalog_id, fields: [
        { label: 'Source advertiser', after: op.accountId }, { label: 'Catalog', after: input.catalog_id }, { label: 'Destination Business Center', after: input.bc_id },
        { label: 'Source ownership verification', after: 'Owner attestation; native check at apply' }, { label: 'Destination role', after: 'ADMIN' },
        { label: 'Contents affected', after: 'Entire catalog and its current products, product sets and video templates' }, { label: 'Project read/write grants', after: 'Unchanged' },
      ], notices: [...notes] },
      execute: async () => {
        await prepare();
        try {
          await this.client.post('catalog/capitalize', { advertiser_id: op.accountId, bc_id: input.bc_id, catalog_id: input.catalog_id });
          await requireCatalogMigrationAccess(this.store, migrationScope(op.accountId, input.bc_id, input.catalog_id), true);
          if (!await this.lookup(selection)) throw new Error('Destination catalog was not found');
          return [input.catalog_id];
        } catch (error) {
          const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
          throw new AdportError('PROVIDER_ERROR', 'Catalog transfer or destination readback is unconfirmed. Inspect the exact destination catalog before another transfer; no request was retried.', { resource_ids: [input.catalog_id], ...(Number.isInteger(details.code) ? { provider_code: details.code } : {}) });
        }
      },
    };
  }
}

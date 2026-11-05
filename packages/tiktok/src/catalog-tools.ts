import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { TikTokAdsProvider } from './provider.js';

export const catalogId = z.string().regex(/^\d{1,30}$/);
export const catalogInput = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const catalogRename = catalogInput.omit({ account_id: true }).extend({ name: z.string().trim().min(1).max(128), expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true) }).strict();
export const catalogAccessChange = catalogInput.omit({ account_id: true }).extend({ mode: z.enum(['none', 'read', 'write']), expected_access_hash: hash }).strict();

export function tiktokCatalogTools(provider: Pick<TikTokAdsProvider, 'catalogs'>, accessManagement = false): AnyToolDefinition[] {
  const read = { namespace: 'tiktok', annotations: { readOnly: true }, presentation: 'records' as const, output: z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) }) };
  return [
    defineTool({ ...read, name: 'tiktok_catalog_access', catalog: { category: 'administration', exposure: 'specialist' }, description: 'List only this project/account’s explicit Business Center catalog grants. Advertiser access alone grants no catalog access. No native Business Center inventory is enumerated.', input: z.object({ account_id: catalogId }).strict(), handler: input => provider.catalogs.access(input.account_id) }),
    defineTool({ ...read, name: 'tiktok_get_catalog', description: 'Read one explicitly granted Business Center catalog, native eligibility and configuration_hash. Verifies exact catalog and Business Center IDs; does not enumerate unrelated catalogs.', input: catalogInput, handler: input => provider.catalogs.get(input) }),
    guardedWriteTool({ name: 'tiktok_update_catalog', namespace: 'tiktok', provider: 'tiktok', kind: 'update', destructive: false, description: 'Rename an explicitly writable catalog using a fresh configuration_hash and shared-effects acknowledgement. Native JSON POST plus independent readback; no ads activated and no automatic retry.', payload: catalogRename }),
    ...(accessManagement ? [
      defineTool({ ...read, name: 'tiktok_catalog_access_snapshot', catalog: { category: 'administration', exposure: 'specialist' }, description: 'Owner settings/local owner only: read the exact current catalog grant hash before reviewing an access change. Not exposed by hosted MCP or public API.', input: catalogInput, handler: input => provider.catalogs.accessSnapshot(input) }),
      guardedWriteTool({ name: 'tiktok_set_catalog_access', namespace: 'tiktok', provider: 'tiktok', catalog: { category: 'administration', exposure: 'specialist' }, kind: 'update', destructive: true, description: 'Owner settings/local owner only: grant read/write access to one Business Center catalog, or revoke it. Shared preview/apply policy, exact grant hash and atomic storage; no native permission grant or ad change.', payload: catalogAccessChange }),
    ] : []),
  ];
}

import { z } from 'zod';

export const catalogId = z.string().regex(/^\d{1,30}$/);
export const catalogInput = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId }).strict();

export const catalogPermissionSelection = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId.optional(), resource_kind: z.enum(['catalog', 'catalog_creation', 'catalog_migration']).optional() }).strict();
export const validCatalogPermission = (input: { catalog_id?: string; resource_kind?: string; mode?: string; acknowledge_source_ownership?: boolean; acknowledge_shared_effects?: boolean }) => input.resource_kind === 'catalog_creation'
  ? !input.catalog_id && (!input.mode || ['none', 'create'].includes(input.mode))
  : input.resource_kind === 'catalog_migration'
    ? !!input.catalog_id && (!input.mode || input.mode === 'none' || input.mode === 'migrate' && input.acknowledge_source_ownership === true && input.acknowledge_shared_effects === true)
    : !!input.catalog_id && (!input.mode || ['none', 'read', 'write'].includes(input.mode));
export const catalogPermissionSnapshot = catalogPermissionSelection.refine(validCatalogPermission, 'Choose an exact catalog/transfer, or creation delegation without a catalog ID');

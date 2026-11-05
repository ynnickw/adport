import { z } from 'zod';

export const catalogId = z.string().regex(/^\d{1,30}$/);
export const catalogInput = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId }).strict();

export const catalogPermissionSelection = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId.optional(), resource_kind: z.enum(['catalog', 'catalog_creation']).optional() }).strict();
export const validCatalogPermission = (input: { catalog_id?: string; resource_kind?: string; mode?: string }) => input.resource_kind === 'catalog_creation' ? !input.catalog_id && (!input.mode || ['none', 'create'].includes(input.mode)) : !!input.catalog_id && input.mode !== 'create';
export const catalogPermissionSnapshot = catalogPermissionSelection.refine(validCatalogPermission, 'Choose an exact catalog or creation delegation without a catalog ID');

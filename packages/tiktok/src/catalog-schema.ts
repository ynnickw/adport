import { z } from 'zod';

export const catalogId = z.string().regex(/^\d{1,30}$/);
export const catalogInput = z.object({ account_id: catalogId, bc_id: catalogId, catalog_id: catalogId }).strict();

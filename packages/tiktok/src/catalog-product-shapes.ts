import { AdportError } from '@adport/core';
import { z } from 'zod';
import { catalogProductFields, catalogProductKinds, type CatalogProductKind, type ProductFieldContract } from './catalog-product-contract.js';

export { catalogProductKinds, type CatalogProductKind };
type Node = ProductFieldContract & { children: Record<string, Node> };
export const productIdentityFields: Record<CatalogProductKind, readonly string[]> = {
  ECOM: ['sku_id'], HOTEL: ['hotel_id'], FLIGHT: ['origin_airport', 'destination_airport'], DESTINATION: ['destination_id'], ENTERTAINMENT: ['media_title_id'],
  AUTO_VEHICLE: ['vehicle_id'], AUTO_MODEL: ['vehicle_id'], MINI_SERIES: ['series_id'], GENERIC: ['item_id'], ONLINE_TO_OFFLINE: ['listing_id'],
};
export const productDeleteFields: Partial<Record<CatalogProductKind, string>> = { ECOM: 'sku_ids', HOTEL: 'hotel_ids', FLIGHT: 'flight_ids', DESTINATION: 'destination_ids', AUTO_VEHICLE: 'vehicle_ids', AUTO_MODEL: 'vehicle_ids', MINI_SERIES: 'series_ids', GENERIC: 'item_ids', ONLINE_TO_OFFLINE: 'listing_ids' };
const schemas = new Map<string, z.ZodObject>();
export function productShape(kind: CatalogProductKind, partial = false): z.ZodObject {
  const key = kind + ':' + partial, cached = schemas.get(key);if (cached) return cached;
  const roots: Record<string, Node> = {};
  for (const field of catalogProductFields[kind]) {
    const path = field.path.split('.');let children = roots;
    for (let index = 0; index < path.length; index++) {
      const part = path[index]!;
      if (index === path.length - 1) children[part] = { ...field, children: {} };
      const node = children[part];if (!node) throw new Error('Invalid product field contract');children = node.children;
    }
  }
  const object = (nodes: Record<string, Node>): z.ZodObject => z.strictObject(Object.fromEntries(Object.entries(nodes).map(([name, field]) => {
    const base = field.type.replace(/\[\]/g, ''), dimensions = (field.type.match(/\[\]/g) ?? []).length;
    let shape: z.ZodType = base === 'object' ? object(field.children) : base === 'string' ? field.enum?.length ? z.enum(field.enum as [string, ...string[]]) : !dimensions && field.max !== undefined ? z.string().max(field.max) : z.string() : base === 'integer' ? z.number().int().safe() : z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
    for (let index = 0; index < dimensions; index++) { const array = shape.array();shape = index === dimensions - 1 && field.max !== undefined ? array.max(field.max) : array; }
    return [name, !partial && field.required ? shape : shape.optional()];
  })));
  const result = object(roots);schemas.set(key, result);return result;
}
export function parseProduct(kind: CatalogProductKind, value: unknown, partial = false): Record<string, unknown> {
  const parsed = productShape(kind, partial).safeParse(value);
  if (!parsed.success) throw new AdportError('INVALID_INPUT', 'Product fields do not match the selected catalog type. Read tiktok_catalog_product_schema for the native structural schema.');
  return parsed.data;
}

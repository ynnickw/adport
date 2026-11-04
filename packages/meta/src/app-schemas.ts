import { z } from 'zod';

const storeUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'Use an HTTPS app-store URL without credentials or a fragment');

export const appPromotedObject = z.object({
  application_id: z.string().regex(/^\d+$/).describe('Meta application ID from meta_advertisable_applications, not the App Store ID'),
  object_store_url: storeUrl.optional(),
}).strict();

export const adSetAppPromotedObject = appPromotedObject.extend({ object_store_url: storeUrl });

// Application.object_store_urls is an API object, not the campaign's singular URL.
export const advertisableApplication = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().nullish(),
  object_store_urls: z.record(z.string(), z.unknown()).nullish(),
});

export const advertisableApplicationsOutput = z.object({
  applications: z.array(advertisableApplication),
  count: z.number().int().nonnegative(),
  next_cursor: z.string().optional(),
  truncated: z.boolean(),
});

export type AppPromotedObject = z.infer<typeof appPromotedObject>;

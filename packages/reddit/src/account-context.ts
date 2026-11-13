import { AdportError } from '@adport/core';
import { z } from 'zod';
import type { RedditAdsClient } from './client.js';
import { redditBusinessId } from './catalog-access.js';
import { redditId } from './schemas.js';

const accountMetadata = z.object({
  id: redditId,
  name: z.string().min(1).optional(),
  business_id: redditBusinessId.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  admin_approval: z.string().min(1).optional(),
});

export const redditAccountContext = accountMetadata.extend({
  catalog_access: z.literal('EXPLICIT_PROJECT_GRANT_REQUIRED'),
});

export async function readAccountContext(client: RedditAdsClient, accountId: string): Promise<z.infer<typeof redditAccountContext>> {
  redditId.parse(accountId);
  const response = await client.get<unknown>(`ad_accounts/${encodeURIComponent(accountId)}`);
  const parsed = accountMetadata.safeParse(response.data);
  if (!parsed.success || parsed.data.id !== accountId) {
    throw new AdportError('PROVIDER_ERROR', 'reddit: account context did not return valid metadata for the selected account');
  }
  return { ...parsed.data, catalog_access: 'EXPLICIT_PROJECT_GRANT_REQUIRED' };
}

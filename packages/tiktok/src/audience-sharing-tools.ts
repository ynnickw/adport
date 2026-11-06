import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { TikTokAdsProvider } from './provider.js';
import { audienceSharesRead, audienceSharingContext, shareAudiences, unshareAudience } from './audience-sharing-schemas.js';

export function tiktokAudienceSharingTools(provider: TikTokAdsProvider): AnyToolDefinition[] {
  const shared = { namespace: 'tiktok', catalog: { category: 'audiences' as const, exposure: 'specialist' as const } }, read = { ...shared, output: z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) }), presentation: 'records' as const, annotations: { readOnly: true }, additionalAccountInputs: ['shared_advertiser_ids'] }, write = { ...shared, provider: 'tiktok', kind: 'update' as const, destructive: true };
  return [
    defineTool({ ...read, name: 'tiktok_custom_audience_shares', description: 'Read owned audience sharing logs for explicit destination accounts. Hosted scope requires source and destinations enabled in this project. Other recipient names/IDs stay hidden. Native status is preserved; missing list data does not prove absence.', input: audienceSharesRead, handler: input => provider.audienceSharing.read(input) }),
    defineTool({ ...read, name: 'tiktok_audience_sharing_context', description: 'Check selected owned audiences, native authorization, source Admin/Operator role and selected accounts in one Business Center. Returns context_hash for SHARE or singular UNSHARE, with exact existing pairs. No access is changed.', input: audienceSharingContext, handler: input => provider.audienceSharing.context(input) }),
    guardedWriteTool({ ...write, name: 'tiktok_share_custom_audiences', payload: shareAudiences, additionalAccountInputs: ['shared_advertiser_ids'], description: 'Share1–10 eligible owned audiences with1–10 selected accounts in the same Business Center after current context and recipient-access acknowledgement. All affected accounts obey project/protected-account policy. Independent pair readback; accepted sharing does not certify audience availability or delivery.' }),
    guardedWriteTool({ ...write, name: 'tiktok_unshare_custom_audience', payload: unshareAudience, additionalAccountInputs: ['shared_advertiser_id'], description: 'Revoke sharing for one exact audience/recipient pair after context and shared-effects acknowledgement. Can affect destination ad targeting. Preserves the source audience; verifies explicit log absence. Does not delete customer data or pause ads.' }),
  ];
}

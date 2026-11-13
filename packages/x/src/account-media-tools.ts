import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { accountMediaUsage, deleteAccountMedia } from './account-media-schemas.js';
import type { XAdsProvider } from './provider.js';

export function xAccountMediaTools(provider: XAdsProvider): AnyToolDefinition[] {
  const shared = { namespace: 'x', catalog: { category: 'creatives' as const, exposure: 'specialist' as const } };
  return [
    defineTool({ ...shared, name: 'x_account_media_usage', description: 'Inspect one Account Media source and complete bounded usage, including deleted-parent references. Reference details are paged; later offsets require the original context hash. Returns deletion eligibility; used sources need separately reviewed disassociation first.', input: accountMediaUsage, output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: ({ account_id, account_media_id, ...input }) => provider.accountMedia.usage(account_id, account_media_id, input) }),
    guardedWriteTool({ ...shared, name: 'x_delete_account_media', provider: 'x', kind: 'remove', destructive: true, description: 'Delete one unused native Account Media source with expected_context_hash and explicit source-deletion acknowledgement. Requires a complete usage scan with no non-deleted ad associations; checks DELETE receipt and independent source/usage readback. No automatic detach, library deletion or retry.', payload: deleteAccountMedia }),
  ];
}

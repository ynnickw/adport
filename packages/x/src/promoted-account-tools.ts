import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { createPromotedAccount, deletePromotedAccount, promotedAccountList, promotedAccountSelection } from './promoted-account-schemas.js';
import { xId } from './schemas.js';

export function xPromotedAccountTools(provider: XAdsProvider): AnyToolDefinition[] {
  const shared = { namespace: 'x', catalog: { category: 'creatives' as const, exposure: 'specialist' as const } };
  return [
    defineTool({ ...shared, name: 'x_promoted_accounts', description: 'View profile-ad associations in one verified PROMOTED_ACCOUNT ad group, with cursor paging, profile links and guarded removal. Native ACTIVE is association state; parent delivery remains separate.', input: promotedAccountList, output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true }, handler: input => provider.promotedAccounts.list(input) }),
    defineTool({ ...shared, name: 'x_get_promoted_account', description: 'Read one exact promoted-account association, including deleted tombstones, verified parents and context_hash. Profile content is live and is not snapshotted by this Ads endpoint.', input: z.object({ account_id: xId, promoted_account_id: xId }).strict(), annotations: { readOnly: true }, handler: input => provider.promotedAccounts.get(input.account_id, input.promoted_account_id) }),
    defineTool({ ...shared, name: 'x_promoted_account_context', description: 'Review a current FULL promotable user, FOLLOWERS ad group and complete bounded association inventory before linking. Binds identity, parent configuration and existing associations to context_hash; no publication or profile edit.', input: promotedAccountSelection.extend({ account_id: xId }).strict(), output: creativesOutput.passthrough(), presentation: 'creatives', annotations: { readOnly: true }, handler: ({ account_id, ...input }) => provider.promotedAccounts.context(account_id, input) }),
    guardedWriteTool({ ...shared, name: 'x_create_promoted_account', provider: 'x', kind: 'create', destructive: true, description: 'Associate one verified FULL promotable profile using expected_context_hash and explicit ACTIVE/live-profile acknowledgements. paused_creation requires a PAUSED ad group. Rejects duplicates, checks receipt and readback, and never retries an uncertain write.', payload: createPromotedAccount }),
    guardedWriteTool({ ...shared, name: 'x_delete_promoted_account', provider: 'x', kind: 'remove', destructive: true, description: 'Disassociate one exact profile ad with expected_context_hash, native DELETE and independent tombstone readback. Preserves the X profile, other ads, parent delivery and budgets. No profile deletion or fictitious PUT status edit.', payload: deletePromotedAccount }),
  ];
}

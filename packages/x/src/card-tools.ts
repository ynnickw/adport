import { creativesOutput, defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { snowflake } from './creative-tools.js';
import { createCard, deleteCard, listCards, updateCard } from './card-schemas.js';
import { xId } from './schemas.js';

export function xCardTools(provider: XAdsProvider): AnyToolDefinition[] {
  const catalog = { category: 'creatives', exposure: 'standard' } as const;
  return [
    defineTool({ name: 'x_cards', namespace: 'x', description: 'Browse native website/app/carousel cards with bounded media previews, copy edits and cursor pagination. Cards are separate from post publication and ad delivery. Legacy inclusion is explicit; this inventory does not replace exact-URI cards/all lookup.', input: listCards, output: creativesOutput.passthrough(), presentation: 'creatives', pagination: { cursorInput: 'cursor' }, catalog, annotations: { readOnly: true, openWorld: false }, handler: v => provider.cards.list(v) }),
    defineTool({ name: 'x_get_card', namespace: 'x', description: 'Read one modern card by numeric ID within the selected account, including full native configuration and configuration_hash for edits/deletion.', input: z.object({ account_id: xId, card_id: snowflake, with_deleted: z.boolean().default(false) }), catalog, annotations: { readOnly: true, openWorld: false }, handler: v => provider.cards.get(v.account_id, v.card_id, v.with_deleted) }),
    guardedWriteTool({ name: 'x_create_card', namespace: 'x', provider: 'x', kind: 'create', description: 'Create an unattached website/app or carousel card from ready account-owned image/video media. Uses the native JSON body and independently verifies content. Does not publish posts or create ad associations. Local preview only; never repeat an unconfirmed creation.', payload: createCard, destructive: false, openWorld: false, catalog }),
    guardedWriteTool({ name: 'x_update_card', namespace: 'x', provider: 'x', kind: 'update', description: 'Edit one modern card using its current configuration hash. Omitted fields stay unchanged; components/slides replace their layout. Copy shortcuts edit a supported current layout and require slide_index for multi-destination cards. Shared changes can affect existing posts/ads immediately; acknowledgement required. No automatic retry.', payload: updateCard, destructive: true, openWorld: false, catalog }),
    guardedWriteTool({ name: 'x_delete_card', namespace: 'x', provider: 'x', kind: 'remove', description: 'Delete one modern card after a matching snapshot and shared-effects acknowledgement. Existing uses may be affected; no restore endpoint is established. Verifies exact native deletion/readback; does not pause an ad or campaign. No automatic retry.', payload: deleteCard, destructive: true, openWorld: false, catalog }),
  ];
}

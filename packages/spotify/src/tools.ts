import { z } from 'zod';
import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { createDraftSchema, setBudgetSchema, setDeliverySchema, setStatusSchema, spotifyId } from './schemas.js';
import type { SpotifyAdsProvider } from './provider.js';

export function spotifyTools(provider: SpotifyAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'spotify_list_campaigns', namespace: 'spotify', description: 'List published Spotify Ads campaigns in the selected account.',
      input: z.object({ account_id: spotifyId }), annotations: { readOnly: true }, handler: input => provider.listCampaigns(input.account_id) }),
    defineTool({ name: 'spotify_get_ad_set', namespace: 'spotify', description: 'Read a Spotify ad set, including its budget and delivery setting.',
      input: z.object({ account_id: spotifyId, ad_set_id: spotifyId }), annotations: { readOnly: true }, handler: input => provider.getAdSet(input.account_id, input.ad_set_id) }),
    guardedWriteTool({ name: 'spotify_create_campaign_draft', namespace: 'spotify', provider: 'spotify', kind: 'create',
      description: 'Create an unpublished Spotify campaign draft, paused by policy. Does not publish or launch ads. Preview is local.', payload: createDraftSchema }),
    guardedWriteTool({ name: 'spotify_set_campaign_status', namespace: 'spotify', provider: 'spotify', kind: 'update',
      description: 'Pause or activate an existing Spotify Ads campaign.', payload: setStatusSchema }),
    guardedWriteTool({ name: 'spotify_set_budget', namespace: 'spotify', provider: 'spotify', kind: 'update',
      description: 'Change a Spotify ad-set budget in integer micros, preserving its current DAILY or LIFETIME type.', payload: setBudgetSchema }),
    guardedWriteTool({ name: 'spotify_set_ad_set_delivery', namespace: 'spotify', provider: 'spotify', kind: 'update',
      description: 'Turn an existing Spotify ad set delivery OFF or ON.', payload: setDeliverySchema }),
  ];
}

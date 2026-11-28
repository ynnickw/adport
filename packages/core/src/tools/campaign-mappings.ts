interface CampaignMapping {
  list: string;
  collection?: 'campaigns' | 'items' | 'rows';
  fields?: readonly [id: string, name: string, status: string];
  activation?: readonly [field: string, value: string];
}

export const CAMPAIGN_MAPPINGS = {
  apple: { list: 'apple_campaigns', collection: 'campaigns', activation: ['status', 'ENABLED'] },
  google: { list: 'google_gaql', collection: 'rows', activation: ['status', 'ENABLED'] },
  gravity: { list: 'gravity_list_campaigns', collection: 'items', fields: ['campaign_id', 'name', 'status'], activation: ['status', 'active'] },
  linkedin: { list: 'linkedin_list_campaigns' },
  meta: { list: 'meta_list_campaigns', collection: 'campaigns' },
  microsoft: { list: 'microsoft_campaigns', collection: 'campaigns', fields: ['Id', 'Name', 'Status'], activation: ['status', 'Active'] },
  openai: { list: 'openai_list_campaigns', activation: ['status', 'active'] },
  pinterest: { list: 'pinterest_list_campaigns' },
  reddit: { list: 'reddit_campaigns', collection: 'campaigns', fields: ['id', 'name', 'configured_status'], activation: ['configured_status', 'ACTIVE'] },
  snapchat: { list: 'snapchat_list_campaigns' },
  spotify: { list: 'spotify_list_campaigns' },
  tiktok: { list: 'tiktok_campaigns', collection: 'campaigns', fields: ['campaign_id', 'campaign_name', 'operation_status'], activation: ['operation_status', 'ENABLE'] },
  x: { list: 'x_list_campaigns', fields: ['id', 'name', 'entity_status'] },
} satisfies Record<string, CampaignMapping>;

export type CampaignProvider = keyof typeof CAMPAIGN_MAPPINGS;
export const CAMPAIGN_PROVIDERS: readonly CampaignProvider[] = Object.keys(CAMPAIGN_MAPPINGS) as CampaignProvider[];

export function campaignMapping(provider: CampaignProvider): CampaignMapping {
  return CAMPAIGN_MAPPINGS[provider];
}

const standardReplacements = new Map<string, string>();
for (const provider of CAMPAIGN_PROVIDERS) {
  if (provider !== 'google') standardReplacements.set(campaignMapping(provider).list, 'campaigns_list');
  if (provider !== 'linkedin') standardReplacements.set(provider + '_set_campaign_status', 'campaign_set_status');
}

export function standardCampaignReplacement(name: string): string | undefined {
  return standardReplacements.get(name);
}

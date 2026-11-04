import type { AnyToolDefinition } from './registry.js';

export const TOOL_PROVIDERS = ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const;
export type ToolProvider = (typeof TOOL_PROVIDERS)[number];
export type ToolProfile = 'standard' | 'reporting' | 'full';
export interface ToolCatalogMetadata {
  category: 'core' | 'reporting' | 'campaigns' | 'creatives' | 'audiences' | 'experiments' | 'measurement' | 'administration';
  exposure: 'standard' | 'specialist' | 'raw';
}
export interface ToolSelection {
  profile: ToolProfile;
  /** Null includes every platform; [] keeps only platform-independent tools. */
  providers: readonly ToolProvider[] | null;
}

// Complete everyday flows, rather than a numerical limit on available tools.
const STANDARD_TOOLS = new Set([
  'projects_list', 'accounts_list', 'report', 'audit_preview', 'audit_run', 'recommendations_list', 'recommendation_dismiss',
  'media_list', 'media_get', 'media_upload', 'media_prepare_upload', 'media_upload_part', 'media_finalize_upload',
  'media_import_file', 'media_inspect_file', 'media_distribution_plan', 'media_distributions',
  'media_rename', 'media_update_metadata', 'media_delete',
  'google_upload_image_asset', 'google_assets', 'apple_upload_asset',
  'reddit_profiles', 'reddit_assets', 'reddit_asset_upload_status', 'reddit_upload_asset',
  'snapchat_media', 'snapchat_create_media', 'snapchat_upload_media', 'snapchat_get_entity',
  'spotify_assets', 'spotify_get_asset', 'spotify_create_asset', 'spotify_upload_asset',
  'pinterest_boards', 'pinterest_get_board', 'pinterest_get_media_upload', 'pinterest_create_image_pin', 'pinterest_create_video_pin',
  'linkedin_media_context', 'linkedin_get_image', 'linkedin_get_library_image', 'linkedin_get_library_video', 'linkedin_get_document', 'linkedin_upload_document',
  'x_authenticated_user_access', 'x_media_library', 'x_get_media_library_item', 'x_upload_media', 'x_media_upload_status', 'x_register_uploaded_media',
  'google_gaql', 'google_create_campaign', 'google_set_campaign_status', 'google_set_budget', 'google_set_bid_ceiling',
  'google_set_bidding_strategy', 'google_create_ad_group', 'google_set_ad_group_status', 'google_add_keywords',
  'google_set_keyword_status', 'google_remove_keywords', 'google_create_responsive_search_ad',
  'meta_list_campaigns', 'meta_get_campaign', 'meta_insights', 'meta_list_ad_sets', 'meta_list_ads',
  'meta_list_pages', 'meta_advertisable_applications', 'meta_create_campaign', 'meta_create_ad_set', 'meta_create_ad', 'meta_create_link_creative',
  'meta_list_creatives', 'meta_list_images', 'meta_list_videos', 'meta_upload_image', 'meta_upload_video',
  'meta_set_campaign_status', 'meta_set_ad_set_status', 'meta_set_ad_status', 'meta_set_budget',
  'meta_set_lifetime_budget', 'meta_set_ad_set_bidding', 'meta_update_ad', 'meta_update_targeting', 'meta_search_targeting',
  'apple_campaigns', 'apple_adgroups', 'apple_keywords', 'apple_negative_keywords', 'apple_ads', 'apple_creatives',
  'apple_product_pages', 'apple_create_campaign', 'apple_create_ad_group', 'apple_create_keyword', 'apple_create_keywords',
  'apple_create_negative_keywords', 'apple_create_creative', 'apple_create_ad', 'apple_set_campaign_status',
  'apple_set_budget', 'apple_set_bid', 'apple_set_campaign_schedule',
]);

const COMMON_OPERATIONS = /^(?:list_campaigns|get_campaign|campaigns|report|insights|list_ad_sets|get_ad_set|list_ad_groups|ad_groups|list_ads|get_ad|list_creatives|get_creative|list_images|list_videos|list_funding_instruments|list_campaign_groups|create_campaign|create_campaign_draft|create_ad_set|create_ad_set_draft|create_ad_group|create_ad|create_ad_draft|create_creative|create_creative_draft|set_campaign_status|set_ad_set_status|set_ad_group_status|set_ad_status|set_budget|set_ad_set_budget|set_ad_set_delivery|search_targeting|upload_image|upload_video)$/;

export function classifyTool(name: string, namespace: string): ToolCatalogMetadata {
  if (/_api_(read|create|update|delete|remove)$/.test(name)) return { category: 'administration', exposure: 'raw' };
  const operation = name.startsWith(`${namespace}_`) ? name.slice(namespace.length + 1) : name;
  const standard = STANDARD_TOOLS.has(name) || (TOOL_PROVIDERS.includes(namespace as ToolProvider) && COMMON_OPERATIONS.test(operation));
  const category: ToolCatalogMetadata['category'] = /experiment|lift_test/.test(operation) ? 'experiments'
    : /conversion|pixel|event_source|offline_event|measurement/.test(operation) ? 'measurement'
    : /audience|targeting|demographic/.test(operation) ? 'audiences'
    : /report|insight|forecast|estimate|keyword_ideas|historical_metrics/.test(operation) ? 'reporting'
    : /creative|image|video|asset|media|product_page|pin|board/.test(operation) || namespace === 'media' ? 'creatives'
    : /campaign|ad_group|ad_set|adset|keyword|budget|bidding|^ads?$|_ad$/.test(operation) ? 'campaigns'
    : ['core', 'audit', 'mock'].includes(namespace) ? 'core' : 'administration';
  return { category, exposure: standard ? 'standard' : 'specialist' };
}

export function toolInSelection(tool: AnyToolDefinition, selection: ToolSelection, includeRawTools = false): boolean {
  const catalog = tool.catalog ?? classifyTool(tool.name, tool.namespace);
  if (catalog.exposure === 'raw' && !includeRawTools) return false;
  if (TOOL_PROVIDERS.includes(tool.namespace as ToolProvider) && selection.providers !== null
    && !selection.providers.includes(tool.namespace as ToolProvider)) return false;
  if (selection.profile === 'reporting') return tool.annotations.readOnly === true;
  return selection.profile === 'full' || catalog.exposure === 'standard';
}

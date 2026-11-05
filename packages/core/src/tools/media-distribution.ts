import { z } from 'zod';
import { AdportError } from '../errors.js';
import { mediaPlatformSchema, type ManagedMediaLibrary, type MediaAsset } from '../media.js';
import { defineTool, type ToolContext } from './registry.js';

/** References to the existing tools, not additional provider implementations. */
export const MEDIA_UPLOAD_TOOLS = new Set(['google_upload_image_asset', 'meta_upload_image', 'meta_upload_video', 'tiktok_upload_image', 'tiktok_upload_video', 'tiktok_upload_product_set', 'tiktok_import_catalog_file', 'tiktok_upload_catalog_videos', 'apple_upload_asset', 'microsoft_upload_image', 'reddit_upload_asset', 'snapchat_upload_media', 'spotify_upload_asset', 'pinterest_upload_video', 'pinterest_create_image_pin', 'linkedin_upload_image', 'linkedin_upload_video', 'linkedin_upload_document', 'x_upload_media']);
export const MEDIA_PREPARATION_TOOLS = new Set(['spotify_create_asset', 'snapchat_create_media']);
const labels: Record<string, string> = { owner_organization: 'LinkedIn organization', promoted_object_id: 'Business Brand ID', as_user_id: 'Authorized X user ID', profile_id: 'Reddit profile ID', poster_media_id: 'Poster image from your library', poster_expected_sha256: 'Poster image checksum', board_id: 'Pinterest board', expected_board_privacy: 'Board visibility', original_content: 'I own this original content', confirm_publication: 'Publish this Pin publicly', asset_id: 'Spotify asset', snapchat_media_id: 'Snapchat media container' };
const parameters = z.record(z.string(), z.unknown()).default({}).refine(value => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 16_384, 'Provider parameters are too large').refine(value => !['account_id', 'project_id', 'media_id', 'file_path', 'expected_sha256', 'pending_operation_id'].some(key => Object.hasOwn(value, key)), 'Source, account and approvals cannot be overridden in parameters');

function recipe(provider: string, asset: MediaAsset, params: Record<string, unknown>) {
  const image = asset.content_type.startsWith('image/'), video = asset.content_type.startsWith('video/'), audio = asset.content_type.startsWith('audio/');
  let tool: string | undefined, defaults: Record<string, unknown> = { name: asset.name.slice(0, 120) }, stage: 'prepare' | 'upload' = 'upload';
  if (provider === 'google' && ['image/png', 'image/jpeg', 'image/gif'].includes(asset.content_type)) tool = 'google_upload_image_asset';
  if (provider === 'meta') tool = ['image/png', 'image/jpeg'].includes(asset.content_type) ? 'meta_upload_image' : ['video/mp4', 'video/quicktime'].includes(asset.content_type) ? 'meta_upload_video' : undefined;
  if (provider === 'tiktok') tool = ['image/png', 'image/jpeg'].includes(asset.content_type) ? 'tiktok_upload_image' : video ? 'tiktok_upload_video' : undefined;
  if (provider === 'apple' && ['image/png', 'image/jpeg', 'image/heic'].includes(asset.content_type)) tool = 'apple_upload_asset';
  if (provider === 'microsoft' && ['image/png', 'image/jpeg'].includes(asset.content_type)) tool = 'microsoft_upload_image';
  if (provider === 'linkedin') tool = ['image/png', 'image/jpeg', 'image/gif'].includes(asset.content_type) ? 'linkedin_upload_image' : asset.content_type === 'video/mp4' ? 'linkedin_upload_video' : asset.content_type === 'application/pdf' ? 'linkedin_upload_document' : undefined;
  if (provider === 'pinterest') tool = ['image/png', 'image/jpeg'].includes(asset.content_type) ? 'pinterest_create_image_pin' : asset.content_type === 'video/mp4' ? 'pinterest_upload_video' : undefined;
  if (provider === 'reddit' && (image || video)) { tool = 'reddit_upload_asset'; defaults.type = image ? 'IMAGE' : 'VIDEO'; }
  if (provider === 'x' && (image || video)) tool = 'x_upload_media';
  if (provider === 'spotify' && (image || video || audio)) {
    tool = params.asset_id ? 'spotify_upload_asset' : 'spotify_create_asset';
    if (!params.asset_id) { stage = 'prepare'; defaults.name = asset.name.length < 2 ? `${asset.name} media` : asset.name.slice(0, 120); defaults.asset_type = image ? 'IMAGE' : video ? 'VIDEO' : 'AUDIO'; if (audio) defaults.asset_subtype = 'USER_UPLOADED_AUDIO'; }
  }
  if (provider === 'snapchat' && (image || video)) {
    tool = params.snapchat_media_id ? 'snapchat_upload_media' : 'snapchat_create_media';
    if (!params.snapchat_media_id) { stage = 'prepare'; defaults.type = image ? 'IMAGE' : 'VIDEO'; }
  }
  return { tool, defaults, stage };
}

export function mediaDistributionTools() {
  return [defineTool({ name: 'media_distribution_plan', namespace: 'core', description: 'Plan reuse of one central project asset across connected, enabled ad accounts. Returns existing guarded provider upload tools and exact source arguments; missing provider-specific choices are explicit. No upload, approval token, ad creation or publication. Spotify/Snapchat first prepare an asset container, then plan again with its ID. Pinterest images create original Pins and require explicit board visibility and content consent.',
    input: z.object({ media_id: z.string().uuid(), provider: mediaPlatformSchema.optional(), account_id: z.string().min(1).optional(), parameters }).refine(value => Boolean(value.provider) === Boolean(value.account_id), 'Choose both provider and account_id, or neither'),
    annotations: { readOnly: true, openWorld: false },
    async handler(input, ctx) {
      const library = ctx.media as ManagedMediaLibrary | undefined;
      if (!library?.get || !ctx.registry) throw new AdportError('NOT_CONNECTED', 'A hosted project media library is required.');
      const asset = await library.get(input.media_id);
      if (asset.status !== 'READY') throw new AdportError('INVALID_INPUT', 'Choose a ready project asset.');
      const destinations = [], errors: Array<{ provider: string; message: string }> = [];
      for (const provider of ctx.providers.list().filter(value => !input.provider || value.id === input.provider)) {
        let accounts;
        try { accounts = await provider.listAccounts(); } catch { errors.push({ provider: provider.id, message: 'Account options are unavailable. Read the provider context before trying again.' }); continue; }
        for (const account of accounts.filter(value => !input.account_id || value.id === input.account_id)) {
          const selectedParameters = { ...input.parameters };
          // Resolve only unambiguous existing ownership, and only after an account
          // was explicitly selected. These are ordinary authorized read tools.
          if (input.provider) {
            try {
              if (provider.id === 'linkedin' && asset.content_type === 'video/mp4' && !selectedParameters.owner_organization) { const context = await ctx.registry.call('linkedin_media_context', { account_id: account.id }, ctx) as { video_owner?: string }; if (context.video_owner) selectedParameters.owner_organization = context.video_owner; }
              if (provider.id === 'x' && !selectedParameters.as_user_id) { const context = await ctx.registry.call('x_authenticated_user_access', { account_id: account.id }, ctx) as { user_id?: string }; if (context.user_id) selectedParameters.as_user_id = context.user_id; }
              if (provider.id === 'reddit' && !selectedParameters.profile_id) { const profiles = await ctx.registry.call('reddit_profiles', { account_id: account.id }, ctx); if (Array.isArray(profiles) && profiles.length === 1 && typeof profiles[0]?.id === 'string') selectedParameters.profile_id = profiles[0].id; }
            } catch { /* Missing or denied context remains an explicit input choice. */ }
          }
          const chosen = recipe(provider.id, asset, selectedParameters);
          if (!chosen.tool) { destinations.push({ provider: provider.id, account_id: account.id, account_name: account.name, available: false, reason: 'This file type has no supported native upload workflow for this channel.' }); continue; }
          let definition;
          try { definition = ctx.registry.get(chosen.tool); } catch { continue; }
          const args = { ...chosen.defaults, ...selectedParameters, account_id: account.id, ...(chosen.stage === 'upload' ? { media_id: asset.id, expected_sha256: asset.sha256 } : {}) };
          const parsed = definition.input.safeParse(args);
          const problems = parsed.success ? [] : parsed.error.issues.map(issue => ({ field: String(issue.path[0] ?? ''), message: issue.message }));
          if (provider.id === 'reddit' && asset.content_type.startsWith('video/') && !selectedParameters.poster_media_id) problems.push({ field: 'poster_media_id', message: 'Choose an approved poster image from the project library.' });
          if (provider.id === 'pinterest' && selectedParameters.expected_board_privacy === 'PUBLIC' && selectedParameters.confirm_publication !== true) problems.push({ field: 'confirm_publication', message: 'Public Pin creation needs explicit publication confirmation.' });
          const fields = [...new Set(problems.map(issue => issue.field))].filter(key => definition.input.shape[key]).map(key => ({ key, label: labels[key] ?? key.replaceAll('_', ' '), schema: z.toJSONSchema(definition.input.shape[key]!, { unrepresentable: 'any' }) }));
          destinations.push({ provider: provider.id, account_id: account.id, account_name: account.name, available: true, stage: chosen.stage, tool: chosen.tool, arguments: parsed.success ? parsed.data : args, ready: parsed.success && !problems.length, fields, problems,
            note: provider.id === 'pinterest' && chosen.tool === 'pinterest_create_image_pin' ? 'Creates original Pinterest content on the selected board. Public boards publish organically; secret content needs the separate secret grant. No ad is attached.' : chosen.stage === 'prepare' ? 'First creates an empty native asset container. Uploading the exact source is a separate approved step.' : 'Uploads a provider copy. Native processing may continue afterward; no ad or serving association is created.' });
        }
      }
      if (input.account_id && !destinations.length && !errors.length) throw new AdportError('POLICY_VIOLATION', 'The destination account is not connected and enabled in this project.');
      return { asset, destinations, errors, note: 'Platform labels organize assets; distribution is separate. Each returned write uses its own normal preview/apply policy. Unknown outcomes must be reconciled before any new upload.' };
    },
  }), defineTool({ name: 'media_distributions', namespace: 'core', description: 'Read the selected project source’s last50 native upload attempts, destinations and resource IDs. ACCEPTED means the upload request completed, not processing readiness or ad publication. STARTED/UNCONFIRMED require reconciliation; never replay them blindly.', input: z.object({ media_id: z.string().uuid() }), annotations: { readOnly: true, openWorld: false }, handler: async ({ media_id }, ctx: ToolContext) => {
    const library = ctx.media as ManagedMediaLibrary | undefined;
    if (!library?.distributions) throw new AdportError('NOT_CONNECTED', 'Distribution history requires hosted project media.');
    return { distributions: await library.distributions(media_id), limit: 50 };
  } })];
}

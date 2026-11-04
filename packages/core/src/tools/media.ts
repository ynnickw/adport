import { z } from 'zod';
import { creativesOutput } from '../creatives.js';
import { AdportError } from '../errors.js';
import { hostFileSchema, mediaAssetSchema, mediaUploadMetadataSchema, mediaWidgetUploadSchema, mediaWriteSchemas, mediaListSchema, type ManagedMediaLibrary } from '../media.js';
import type { AdProvider } from '../provider.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from './registry.js';
import { guardedWriteTool } from './write.js';
import { mediaDistributionTools } from './media-distribution.js';

const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

function managed(ctx: ToolContext): ManagedMediaLibrary {
  const media = ctx.media as ManagedMediaLibrary | undefined;
  if (!media?.scopeId || !media.get || !media.previewWrite || !media.applyWrite) throw new AdportError('NOT_CONNECTED', 'Connect to a hosted project to manage its media. Local provider uploads accept file_path directly.');
  return media;
}
function target(ctx: ToolContext) {
  const media = managed(ctx);
  const provider: AdProvider = { id: 'media', capabilities: () => ({ serverDryRun: false }), listAccounts: async () => [], report: async () => { throw new AdportError('INVALID_INPUT', 'Media has no advertising report.'); }, previewWrite: op => media.previewWrite(op), applyWrite: op => media.applyWrite(op) };
  return { provider, accountId: media.scopeId };
}

export function mediaTools(): AnyToolDefinition[] {
  return [defineTool({
    name: 'media_list', namespace: 'core',
    description: 'Search central project media by name, kind, tag or platform label, with SHA-256 and previews. Labels do not publish. Upload via media_inspect_file → media_import_file (ChatGPT), media_upload (up to1MiB), or prepare → PUT/parts → finalize (up to50MiB). Use media_distribution_plan to reuse exact source bytes on channels.',
    input: mediaListSchema,
    output: creativesOutput.extend({ assets: z.array(mediaAssetSchema), upload_page_url: z.string().url().optional(), upload_config: mediaWidgetUploadSchema.optional() }),
    presentation: 'creatives', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true, openWorld: false },
    async handler(input, ctx) {
      if (!ctx.media) throw new AdportError('NOT_CONNECTED', 'A hosted project media library is required. Local uploads accept file_path and expected_sha256.');
      const result = await ctx.media.list(input);
      return { ...result, creatives: result.assets.map(asset => ({
        id: asset.id, name: asset.name, provider: 'media', account_id: '', type: asset.content_type, ...(asset.status ? { status: asset.status } : {}),
        headlines: [], descriptions: [`${sizeLabel(asset.byte_length)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}`, ...(asset.tags?.length ? [`Tags: ${asset.tags.join(', ')}`] : []), ...(asset.platforms?.length ? [`Platforms: ${asset.platforms.join(', ')}`] : [])], landing_urls: [],
        actions: asset.metadata_version ? [{ label: 'Organize asset', tool: 'media_update_metadata', arguments: { media_id: asset.id, expected_sha256: asset.sha256, expected_version: asset.metadata_version }, fields: [{ key: 'name', label: 'Name', type: 'text' as const, value: asset.name, max_length: 240 }, { key: 'tags', label: 'Tags (one per line)', type: 'text_list' as const, value: asset.tags ?? [] }, { key: 'platforms', label: 'Platform IDs (one per line)', type: 'text_list' as const, value: asset.platforms ?? [] }] }] : [],
        media: asset.preview_url && /^(image|video|audio)\//.test(asset.content_type) ? [{ type: asset.content_type.startsWith('image/') ? 'image' : asset.content_type.startsWith('video/') ? 'video' : 'audio', url: asset.preview_url, alt: asset.name }] : [],
      })) };
    },
  }),
  defineTool({ name: 'media_get', namespace: 'core', description: 'Get project media metadata, processing/deletion status and a temporary download URL for ready files. Pending uploads include part size/count and received part indexes for reconciliation. Download asset.preview_url with HTTP GET; preserve its SHA-256.', input: z.object({ media_id: z.string().uuid() }), output: z.object({ asset: mediaAssetSchema }), annotations: { readOnly: true, openWorld: false }, handler: async (input, ctx) => ({ asset: await managed(ctx).get(input.media_id) }) }),
  ...mediaDistributionTools(),
  defineTool({ name: 'media_inspect_file', namespace: 'core', description: 'Inspect a host-provided ChatGPT attachment without storing it: download exact bytes from the allowed OpenAI file origin, detect MIME, verify size, decode images and compute SHA-256. No base64 or dashboard. Use returned metadata with media_import_file to preview a private project import. Other hosts need a supported file transport.', input: z.object({ file: hostFileSchema }), output: z.object({ file_id: z.string(), metadata: mediaUploadMetadataSchema, width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }), fileInputs: ['file'], annotations: { readOnly: true, openWorld: true }, handler: async ({ file }, ctx) => { const library = managed(ctx); if (!library.inspectFile) throw new AdportError('NOT_CONNECTED', 'This runtime does not support host file imports.'); return library.inspectFile(file); } }),
  ...([
    ['media_prepare_upload', 'Reserve an immutable project file up to 50 MiB. Apply returns a temporary raw HTTP PUT grant and an MCP-only media_upload_part plan. Transfer the bytes by either method, then preview/apply media_finalize_upload. No dashboard, ad account mutation or publication.'],
    ['media_upload', 'Upload a small project file directly as canonical base64 (at most 1 MiB decoded). SHA-256, declared length and actual MIME must match. Preview verifies bytes; apply stores and verifies them, returning media_id. For larger files use media_prepare_upload with raw HTTP PUT or media_upload_part.'],
    ['media_import_file', 'Import a ChatGPT host-provided attachment into private project media, up to 50 MiB, without base64, external upload commands or a dashboard. First media_inspect_file supplies exact name/MIME/size/SHA-256. Preview and apply download and verify the same approved bytes; changed or expired files reject. No advertising upload or publication.'],
    ['media_finalize_upload', 'Verify a prepared raw-byte or MCP-part upload and mark it ready for provider tools. Requires the reserved whole-file checksum. Preview checks stored bytes without finalizing; apply assembles parts if needed and returns immutable media_id, SHA-256 and metadata.'],
    ['media_upload_part', 'Transfer one immutable 1 MiB base64 part through MCP after media_prepare_upload. Zero-based indexes; only the last part may be shorter. Bind the reserved whole-file checksum and exact part checksum. Preview/apply each part; inspect media_get after unknown outcomes. Finalize separately.'],
    ['media_rename', 'Rename project media metadata after matching its current name and immutable SHA-256. File bytes, ID and existing provider copies are preserved.'],
    ['media_update_metadata', 'Organize a central project asset: change its name, replace its tags and/or assign platform labels. Read media_get first for expected_version and SHA-256. Labels do not upload, publish or change provider ads. Omitted metadata is preserved; empty arrays clear labels.'],
    ['media_delete', 'Permanently remove a project library source after matching its current name and SHA-256. Blocks further reuse and removes stored bytes; expired-grant cleanup retains a temporary deletion record. Does not delete provider copies, ads or campaigns.'],
  ] as const).map(([name, description]) => guardedWriteTool({ name, namespace: 'core', provider: 'media', kind: name === 'media_delete' ? 'remove' : name === 'media_rename' || name === 'media_update_metadata' || name === 'media_finalize_upload' || name === 'media_upload_part' ? 'update' : 'create', payload: mediaWriteSchemas[name], description, destructive: name === 'media_delete', ...(name === 'media_import_file' ? { fileInputs: ['file'], openWorld: true } : {}), contextTarget: target })),
  ];
}

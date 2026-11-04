import { z } from 'zod';
import { creativesOutput } from '../creatives.js';
import { AdportError } from '../errors.js';
import { mediaAssetSchema, mediaWriteSchemas, type ManagedMediaLibrary } from '../media.js';
import type { AdProvider } from '../provider.js';
import { defineTool, type AnyToolDefinition, type ToolContext } from './registry.js';
import { guardedWriteTool } from './write.js';

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
    description: 'List immutable project media with SHA-256, dimensions and temporary previews. Upload without a dashboard using media_upload (up to 1 MiB) or media_prepare_upload → HTTP PUT or media_upload_part → media_finalize_upload (up to 50 MiB). Use media_id and sha256 in provider upload tools.',
    input: z.object({ limit: z.number().int().positive().max(100).default(24), cursor: z.string().uuid().optional() }),
    output: creativesOutput.extend({ assets: z.array(mediaAssetSchema), upload_page_url: z.string().url().optional() }),
    presentation: 'creatives', pagination: { cursorInput: 'cursor' }, annotations: { readOnly: true, openWorld: false },
    async handler(input, ctx) {
      if (!ctx.media) throw new AdportError('NOT_CONNECTED', 'A hosted project media library is required. Local uploads accept file_path and expected_sha256.');
      const result = await ctx.media.list(input);
      return { ...result, creatives: result.assets.map(asset => ({
        id: asset.id, name: asset.name, provider: 'media', account_id: '', type: asset.content_type, ...(asset.status ? { status: asset.status } : {}),
        headlines: [], descriptions: [`${sizeLabel(asset.byte_length)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}`], landing_urls: [], actions: [],
        media: asset.preview_url && /^(image|video|audio)\//.test(asset.content_type) ? [{ type: asset.content_type.startsWith('image/') ? 'image' : asset.content_type.startsWith('video/') ? 'video' : 'audio', url: asset.preview_url, alt: asset.name }] : [],
      })) };
    },
  }),
  defineTool({ name: 'media_get', namespace: 'core', description: 'Get project media metadata, processing/deletion status and a temporary download URL for ready files. Pending uploads include part size/count and received part indexes for reconciliation. Download asset.preview_url with HTTP GET; preserve its SHA-256.', input: z.object({ media_id: z.string().uuid() }), output: z.object({ asset: mediaAssetSchema }), annotations: { readOnly: true, openWorld: false }, handler: async (input, ctx) => ({ asset: await managed(ctx).get(input.media_id) }) }),
  ...([
    ['media_prepare_upload', 'Reserve an immutable project file up to 50 MiB. Apply returns a temporary raw HTTP PUT grant and an MCP-only media_upload_part plan. Transfer the bytes by either method, then preview/apply media_finalize_upload. No dashboard, ad account mutation or publication.'],
    ['media_upload', 'Upload a small project file directly as canonical base64 (at most 1 MiB decoded). SHA-256, declared length and actual MIME must match. Preview verifies bytes; apply stores and verifies them, returning media_id. For larger files use media_prepare_upload with raw HTTP PUT or media_upload_part.'],
    ['media_finalize_upload', 'Verify a prepared raw-byte or MCP-part upload and mark it ready for provider tools. Requires the reserved whole-file checksum. Preview checks stored bytes without finalizing; apply assembles parts if needed and returns immutable media_id, SHA-256 and metadata.'],
    ['media_upload_part', 'Transfer one immutable 1 MiB base64 part through MCP after media_prepare_upload. Zero-based indexes; only the last part may be shorter. Bind the reserved whole-file checksum and exact part checksum. Preview/apply each part; inspect media_get after unknown outcomes. Finalize separately.'],
    ['media_rename', 'Rename project media metadata after matching its current name and immutable SHA-256. File bytes, ID and existing provider copies are preserved.'],
    ['media_delete', 'Permanently remove a project library source after matching its current name and SHA-256. Blocks further reuse and removes stored bytes; expired-grant cleanup retains a temporary deletion record. Does not delete provider copies, ads or campaigns.'],
  ] as const).map(([name, description]) => guardedWriteTool({ name, namespace: 'core', provider: 'media', kind: name === 'media_delete' ? 'remove' : name === 'media_rename' || name === 'media_finalize_upload' || name === 'media_upload_part' ? 'update' : 'create', payload: mediaWriteSchemas[name], description, destructive: name === 'media_delete', contextTarget: target })),
  ];
}

import { z } from 'zod';
import { creativesOutput } from '../creatives.js';
import { AdportError } from '../errors.js';
import { mediaAssetSchema } from '../media.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const sizeLabel = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

export function mediaTools(): AnyToolDefinition[] {
  return [defineTool({
    name: 'media_list', namespace: 'core',
    description: 'List immutable project media with SHA-256, dimensions and temporary previews. Use a returned media_id and sha256 for a guarded provider upload. upload_page_url opens the project upload library. Local CLI uploads can instead use an absolute file_path.',
    input: z.object({ limit: z.number().int().positive().max(100).default(24), cursor: z.string().uuid().optional() }),
    output: creativesOutput.extend({ assets: z.array(mediaAssetSchema), upload_page_url: z.string().url().optional() }),
    presentation: 'creatives', annotations: { readOnly: true, openWorld: false },
    async handler(input, ctx) {
      if (!ctx.media) throw new AdportError('NOT_CONNECTED', 'A hosted project media library is required. Local uploads accept file_path and expected_sha256.');
      const result = await ctx.media.list(input);
      return { ...result, creatives: result.assets.map(asset => ({
        id: asset.id, name: asset.name, provider: 'media', account_id: '', type: asset.content_type, ...(asset.status ? { status: asset.status } : {}),
        headlines: [], descriptions: [`${sizeLabel(asset.byte_length)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}`], landing_urls: [], actions: [],
        media: asset.preview_url ? [{ type: asset.content_type.startsWith('image/') ? 'image' : asset.content_type.startsWith('video/') ? 'video' : 'audio', url: asset.preview_url, alt: asset.name }] : [],
      })) };
    },
  })];
}

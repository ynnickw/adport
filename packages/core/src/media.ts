import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AdportError } from './errors.js';
import type { WriteOperation, WritePreview, WriteResult } from './provider.js';
import { MEDIA_PLATFORMS } from './media-platforms.js';
export { MEDIA_PLATFORMS } from './media-platforms.js';

export const MAX_PROJECT_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_INLINE_MEDIA_BYTES = 1024 * 1024;
export const MEDIA_UPLOAD_PART_BYTES = MAX_INLINE_MEDIA_BYTES;
export const PROJECT_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'application/pdf'] as const;
export const mediaUploadMetadataSchema = z.object({
  name: z.string().trim().min(1).max(240), content_type: z.enum(PROJECT_MEDIA_TYPES),
  byte_length: z.number().int().positive().max(MAX_PROJECT_MEDIA_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const mediaWidgetUploadSchema = z.object({
  project_id: z.string().uuid(), storage_origin: z.string().url(), max_bytes: z.number().int().positive().max(MAX_PROJECT_MEDIA_BYTES),
  content_types: z.array(z.enum(PROJECT_MEDIA_TYPES)).min(1),
});
/** Host-injected file references; bytes stay outside the model's tool arguments. */
export const hostFileSchema = z.object({
  download_url: z.string().min(1).max(16_384), file_id: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  mime_type: z.string().max(100).optional(), file_name: z.string().max(240).optional(),
}).strict();
export type HostFile = z.infer<typeof hostFileSchema>;
const existing = { media_id: z.string().uuid(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) };
export const mediaPlatformSchema = z.enum(MEDIA_PLATFORMS);
const tags = z.array(z.string().trim().min(1).max(40).regex(/^[^\x00-\x1f\x7f]+$/).transform(value => value.toLowerCase())).max(24).transform(values => [...new Set(values)].sort());
const platforms = z.array(mediaPlatformSchema).max(MEDIA_PLATFORMS.length).transform(values => [...new Set(values)].sort());
export const mediaListSchema = z.object({ limit: z.number().int().positive().max(100).default(24), cursor: z.string().uuid().optional(), query: z.string().trim().max(200).optional(), kind: z.enum(['image', 'video', 'audio', 'document']).optional(), platform: mediaPlatformSchema.optional(), tag: z.string().trim().min(1).max(40).transform(value => value.toLowerCase()).optional() });
export type MediaListInput = z.infer<typeof mediaListSchema>;
export const mediaWriteSchemas = {
  media_prepare_upload: mediaUploadMetadataSchema,
  media_upload: mediaUploadMetadataSchema.safeExtend({ byte_length: z.number().int().positive().max(MAX_INLINE_MEDIA_BYTES), data_base64: z.string().min(4).max(4 * Math.ceil(MAX_INLINE_MEDIA_BYTES / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/) }),
  media_import_file: mediaUploadMetadataSchema.safeExtend({ file: hostFileSchema }),
  media_finalize_upload: z.object(existing),
  media_upload_part: z.object({ ...existing, part_index: z.number().int().min(0).max(Math.ceil(MAX_PROJECT_MEDIA_BYTES / MEDIA_UPLOAD_PART_BYTES) - 1), part_sha256: z.string().regex(/^[a-f0-9]{64}$/), data_base64: z.string().min(4).max(4 * Math.ceil(MEDIA_UPLOAD_PART_BYTES / 3)).regex(/^[A-Za-z0-9+/]*={0,2}$/) }),
  media_rename: z.object({ ...existing, expected_name: z.string(), name: mediaUploadMetadataSchema.shape.name }),
  media_delete: z.object({ ...existing, expected_name: z.string() }),
  media_update_metadata: z.object({ ...existing, expected_version: z.number().int().positive(), name: mediaUploadMetadataSchema.shape.name.optional(), tags: tags.optional(), platforms: platforms.optional() }).strict().refine(value => value.name !== undefined || value.tags !== undefined || value.platforms !== undefined, 'Provide a name, tags or platforms to change'),
};

export const mediaSourceFields = {
  media_id: z.string().uuid().optional().describe('Immutable ID returned by media_upload or media_finalize_upload; required for hosted provider uploads'),
  file_path: z.string().min(1).optional().describe('Absolute local file path; local CLI/stdio only'),
  expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).describe('SHA-256 of the exact bytes approved for upload'),
};

export interface MediaSource { media_id?: string; file_path?: string; expected_sha256: string }
export interface VerifiedMedia { bytes: Uint8Array<ArrayBuffer>; name: string; contentType: string; sha256: string }
export interface MediaResolver {
  read(source: MediaSource, options?: { maxBytes?: number; contentTypes?: readonly string[] }): Promise<VerifiedMedia>;
  /** Optional private staging for providers whose servers pull media over HTTPS. */
  providerUrl?(source: MediaSource, options?: { maxBytes?: number; contentTypes?: readonly string[] }): Promise<{ url: string; expires_at: string; sha256: string }>;
}
export const mediaAssetSchema = z.object({
  id: z.string().uuid(), name: z.string(), content_type: z.string(), byte_length: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  status: z.enum(['READY', 'PROCESSING', 'FAILED', 'DELETED']).optional(),
  preview_url: z.string().url().optional(),
  tags: z.array(z.string()).optional(), platforms: z.array(mediaPlatformSchema).optional(), metadata_version: z.number().int().positive().optional(), created_at: z.string().optional(),
  upload: z.object({ part_size: z.number().int().positive(), part_count: z.number().int().positive(), received_parts: z.array(z.object({ part_index: z.number().int().nonnegative(), byte_length: z.number().int().nonnegative() })), expires_at: z.string() }).optional(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export interface MediaLibrary extends MediaResolver {
  list(input: MediaListInput): Promise<{ assets: MediaAsset[]; truncated: boolean; next_cursor?: string; upload_page_url?: string; upload_config?: z.infer<typeof mediaWidgetUploadSchema> }>;
  trackUpload?(input: { media_id: string; expected_sha256: string; provider: string; account_id: string; tool: string }, execute: () => Promise<WriteResult>): Promise<WriteResult>;
}
export interface ManagedMediaLibrary extends MediaLibrary {
  readonly scopeId: string;
  get(id: string): Promise<MediaAsset>;
  distributions?(id: string): Promise<unknown[]>;
  inspectFile?(file: HostFile): Promise<{ file_id: string; metadata: z.infer<typeof mediaUploadMetadataSchema>; width?: number; height?: number }>;
  previewWrite(op: WriteOperation): Promise<WritePreview>;
  applyWrite(op: WriteOperation): Promise<WriteResult>;
}

export function mediaContentType(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(b.subarray(0, 10).toString('ascii'))) return 'application/pdf';
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'image/gif';
  if (b.subarray(4, 8).toString() === 'ftyp') {
    const brand = b.subarray(8, 12).toString();
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (b.subarray(0, 3).toString() === 'ID3' || (b[0] === 255 && ((b[1] ?? 0) & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
  if (b.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return undefined;
}

/** Verify at preview AND apply; a path or mutable object cannot replace approved bytes. */
export function verifyMedia(bytes: Uint8Array<ArrayBuffer>, name: string, expectedSha256: string,
  options: { maxBytes?: number; contentTypes?: readonly string[] } = {}): VerifiedMedia {
  if (!bytes.byteLength || bytes.byteLength > (options.maxBytes ?? 100 * 1024 * 1024)) {
    throw new AdportError('INVALID_INPUT', 'Media is empty or exceeds the upload size limit.');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256) || sha256 !== expectedSha256.toLowerCase()) {
    throw new AdportError('INVALID_INPUT', 'Media SHA-256 mismatch. Prepare a new preview for the changed file.');
  }
  const contentType = mediaContentType(bytes);
  if (!contentType || (options.contentTypes && !options.contentTypes.includes(contentType))) {
    throw new AdportError('INVALID_INPUT', 'The file contents are not a supported media format.');
  }
  return { bytes, name: basename(name).replace(/[\x00-\x1f\x7f]/g, '_'), contentType, sha256 };
}

/** Never inject this resolver into a hosted runtime. Hosted resolvers only read scoped media IDs. */
export class LocalMediaResolver implements MediaResolver {
  async read(source: MediaSource, options: { maxBytes?: number; contentTypes?: readonly string[] } = {}): Promise<VerifiedMedia> {
    if (source.media_id || !source.file_path || !isAbsolute(source.file_path)) {
      throw new AdportError('INVALID_INPUT', 'Local uploads require an absolute file_path and no media_id.');
    }
    return verifyMedia(await this.load(source.file_path, options.maxBytes), source.file_path, source.expected_sha256, options);
  }

  async inspect(filePath: string, options: { maxBytes?: number; contentTypes?: readonly string[] } = {}): Promise<VerifiedMedia> {
    if (!isAbsolute(filePath)) throw new AdportError('INVALID_INPUT', 'Use an absolute local media path.');
    const bytes = await this.load(filePath, options.maxBytes);
    return verifyMedia(bytes, filePath, createHash('sha256').update(bytes).digest('hex'), options);
  }

  private async load(filePath: string, limit?: number): Promise<Uint8Array<ArrayBuffer>> {
    const source = { file_path: filePath };
    const maxBytes = limit ?? 100 * 1024 * 1024;
    const original = await lstat(source.file_path);
    if (!original.isFile() || original.isSymbolicLink()) throw new AdportError('INVALID_INPUT', 'Media must be a regular file, not a symbolic link.');
    const file = await open(source.file_path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (stat.dev !== original.dev || stat.ino !== original.ino) throw new AdportError('INVALID_INPUT', 'Media changed while it was being opened. Prepare a new preview.');
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new AdportError('INVALID_INPUT', 'Media must be a regular file within the upload size limit.');
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= maxBytes) {
        const chunk = Buffer.alloc(Math.min(1024 * 1024, maxBytes + 1 - size));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > maxBytes) throw new AdportError('INVALID_INPUT', 'Media exceeds the upload size limit.');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return Buffer.concat(chunks);
    } finally { await file.close(); }
  }
}

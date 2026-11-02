import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AdportError } from './errors.js';

export const mediaSourceFields = {
  media_id: z.string().uuid().optional().describe('Immutable media ID from the project asset library; required for hosted uploads'),
  file_path: z.string().min(1).optional().describe('Absolute local file path; local CLI/stdio only'),
  expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).describe('SHA-256 of the exact bytes approved for upload'),
};

export interface MediaSource { media_id?: string; file_path?: string; expected_sha256: string }
export interface VerifiedMedia { bytes: Uint8Array<ArrayBuffer>; name: string; contentType: string; sha256: string }
export interface MediaResolver { read(source: MediaSource, options?: { maxBytes?: number; contentTypes?: readonly string[] }): Promise<VerifiedMedia> }
export const mediaAssetSchema = z.object({
  id: z.string().uuid(), name: z.string(), content_type: z.string(), byte_length: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  preview_url: z.string().url().optional(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export interface MediaLibrary extends MediaResolver {
  list(input: { limit: number; cursor?: string }): Promise<{ assets: MediaAsset[]; truncated: boolean; next_cursor?: string; upload_page_url?: string }>;
}

export function mediaContentType(bytes: Uint8Array): string | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
    const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
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
      return verifyMedia(Buffer.concat(chunks), source.file_path, source.expected_sha256, options);
    } finally { await file.close(); }
  }
}

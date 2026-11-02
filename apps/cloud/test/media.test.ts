import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectMediaBytes, mediaUploadSchema, ProjectMediaLibrary } from '@/lib/cloud/media';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('private creative media verification', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('fully decodes %s and retains the approved bytes/checksum', async format => {
    const bytes = await sharp({ create: { width: 1200, height: 628, channels: 3, background: '#ff6600' } }).toFormat(format).toBuffer();
    const result = await inspectMediaBytes(bytes, { name: 'creative', content_type: format === 'jpeg' ? 'image/jpeg' : `image/${format}`, byte_length: bytes.byteLength, sha256: hash(bytes) });
    expect(result).toMatchObject({ width: 1200, height: 628, file: { sha256: hash(bytes) } });
    expect(Buffer.from(result.file.bytes).equals(bytes)).toBe(true);
  });

  it('rejects size, checksum, MIME mismatches and fake images before publication to the library', async () => {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    const metadata = { name: 'creative.png', content_type: 'image/png' as const, byte_length: bytes.byteLength, sha256: hash(bytes) };
    await expect(inspectMediaBytes(bytes, { ...metadata, byte_length: 1 })).rejects.toThrow('size');
    await expect(inspectMediaBytes(bytes, { ...metadata, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    await expect(inspectMediaBytes(bytes, { ...metadata, content_type: 'image/jpeg' })).rejects.toThrow('media type');
    const broken = Buffer.concat([bytes.subarray(0, 8), Buffer.from('not a PNG container')]);
    await expect(inspectMediaBytes(broken, { ...metadata, byte_length: broken.byteLength, sha256: hash(broken) })).rejects.toThrow('decoded');
    expect(mediaUploadSchema.safeParse({ ...metadata, content_type: 'text/html' }).success).toBe(false);
  });

  it('never reads a server-local path for a hosted provider upload', async () => {
    const library = new ProjectMediaLibrary({ organizationId: '00000000-0000-4000-8000-000000000001', role: 'owner', scopes: ['tools:read', 'tools:write'] });
    await expect(library.read({ file_path: '/etc/passwd', expected_sha256: '0'.repeat(64) })).rejects.toThrow('server file paths');
    await expect(library.read({ media_id: 'invalid', expected_sha256: '0'.repeat(64) })).rejects.toThrow('valid project media_id');
  });
});

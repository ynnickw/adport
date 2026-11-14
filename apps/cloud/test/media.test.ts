import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { inspectMediaBytes, mediaUploadSchema, ProjectMediaLibrary } from '@/lib/cloud/media';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('private creative media verification', () => {
  it('validates declared CSV after renaming without an extension, preserving exact source bytes', async () => {
    const bytes = Buffer.from('sku_id\r\n00012\r\n9007199254740993\r\n');
    const metadata = { name: 'Product IDs', content_type: 'text/csv' as const, byte_length: bytes.length, sha256: hash(bytes) };
    expect(mediaUploadSchema.safeParse(metadata).success).toBe(true);
    expect(await inspectMediaBytes(bytes, metadata)).toMatchObject({ file: { bytes, contentType: 'text/csv', sha256: metadata.sha256 } });
    const malformed = Buffer.from('sku_id\n"unclosed');
    await expect(inspectMediaBytes(malformed, { ...metadata, byte_length: malformed.length, sha256: hash(malformed) })).rejects.toThrow('UTF-8 CSV');
    await expect(inspectMediaBytes(bytes, { ...metadata, content_type: 'application/pdf' })).rejects.toThrow();
  });
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

  it('reviews verified uploads without duplicate payload fields or attached bytes', async () => {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    const library = new ProjectMediaLibrary({ organizationId: '00000000-0000-4000-8000-000000000001', role: 'owner', scopes: ['tools:read', 'tools:write'] });
    const op = { tool: 'media_upload', provider: 'media', accountId: library.scopeId, kind: 'create' as const, payload: { name: 'qa.png', content_type: 'image/png', byte_length: bytes.length, sha256: hash(bytes), data_base64: bytes.toString('base64') } };
    const preview = await library.previewWrite(op);
    expect(preview.review?.fields).toEqual([{ label: 'Type', after: 'image/png' }, { label: 'Size', after: `${bytes.length} bytes` }, { label: 'SHA-256', after: hash(bytes) }]);
    expect(preview.review).toMatchObject({ title: 'Upload file', subject: 'qa.png', notices: expect.arrayContaining(['File bytes, type, size and SHA-256 verified.']) });
    expect(JSON.stringify(preview.review)).not.toContain(bytes.toString('base64')); expect(preview.serverValidated).toBe(false);
    await expect(library.previewWrite({ ...op, payload: { ...op.payload, sha256: '0'.repeat(64) } })).rejects.toThrow('SHA-256');
    const reserved = await library.previewWrite({ ...op, tool: 'media_prepare_upload', payload: { ...op.payload, data_base64: undefined } });
    expect(reserved.review?.title).toBe('Prepare upload'); expect(reserved.review?.notices).toContain('File bytes will be verified after transfer.');
    expect(reserved.review?.notices).not.toContain('File bytes, type, size and SHA-256 verified.');
  });
});

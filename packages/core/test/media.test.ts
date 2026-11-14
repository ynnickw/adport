import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalMediaResolver, verifyMedia } from '../src/media.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('checksum-bound media', () => {
  it('uses the bytes rather than a filename or declared MIME type', () => {
    expect(verifyMedia(png, 'misleading.jpg', hash(png))).toMatchObject({ contentType: 'image/png', sha256: hash(png) });
    const svg = Buffer.from('<svg onload="alert(1)"/>');
    expect(() => verifyMedia(svg, 'image.png', hash(svg))).toThrow('supported media');
    expect(() => verifyMedia(png, 'image.png', hash(png), { contentTypes: ['video/mp4'] })).toThrow('supported media');
    expect(() => verifyMedia(png, 'image.png', hash(png), { maxBytes: 2 })).toThrow('size limit');
  });
  it('identifies PDF bytes independently of the filename and rejects a malformed header', () => {
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
    expect(verifyMedia(pdf, 'misleading.png', hash(pdf), { contentTypes: ['application/pdf'] })).toMatchObject({ contentType: 'application/pdf' });
    expect(() => verifyMedia(pdf, 'document.pdf', hash(pdf), { contentTypes: ['image/png'] })).toThrow('supported media');
    const invalid = Buffer.from('%PDF-9.9\n<html>not a PDF</html>');
    expect(() => verifyMedia(invalid, 'document.pdf', hash(invalid))).toThrow('supported media');
  });

  it('reopens and rechecks bytes for every invocation, rejecting file replacement and symlinks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adport-media-'));
    try {
      const file = join(directory, 'creative.png'), link = join(directory, 'alias.png');
      await writeFile(file, png);
      const resolver = new LocalMediaResolver(), source = { file_path: file, expected_sha256: hash(png) };
      await expect(resolver.read(source)).resolves.toMatchObject({ name: 'creative.png', contentType: 'image/png' });
      await writeFile(file, Buffer.concat([png, Buffer.from('changed')]));
      await expect(resolver.read(source)).rejects.toThrow('SHA-256 mismatch');
      await symlink(file, link);
      await expect(resolver.read({ ...source, file_path: link })).rejects.toThrow();
      await expect(resolver.read({ ...source, file_path: 'relative.png' })).rejects.toThrow('absolute');
      await expect(resolver.read({ ...source, media_id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow('no media_id');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

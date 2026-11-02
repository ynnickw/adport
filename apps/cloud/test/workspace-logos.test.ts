import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceLogo } from '@/lib/cloud/workspace-logos';
import { MAX_LOGO_BYTES } from '@/lib/workspace-logos';

describe('workspace logo validation', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s uploads and produces a bounded PNG without cropping', async format => {
    const bytes = await sharp({ create: { width: 600, height: 300, channels: 4, background: '#ff660080' } }).toFormat(format).toBuffer();
    const result = await normalizeWorkspaceLogo(new File([new Uint8Array(bytes)], 'logo', { type: format === 'jpeg' ? 'image/jpeg' : `image/${format}` }));
    const metadata = await sharp(result).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: 256, height: 128 });
    if (format !== 'jpeg') expect(metadata.hasAlpha).toBe(true);
    expect(metadata.exif).toBeUndefined();
  });

  it('rejects empty, oversized, malformed, and disguised vector uploads', async () => {
    for (const file of [
      new File([], 'empty.png', { type: 'image/png' }),
      new File([new Uint8Array(MAX_LOGO_BYTES + 1)], 'large.png', { type: 'image/png' }),
      new File(['not an image'], 'fake.png', { type: 'image/png' }),
      new File(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], 'fake.png', { type: 'image/png' }),
      new File(['anything'], 'logo.svg', { type: 'image/svg+xml' }),
    ]) await expect(normalizeWorkspaceLogo(file)).rejects.toMatchObject({ status: 400 });
  });
});

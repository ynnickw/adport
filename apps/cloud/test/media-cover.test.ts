import { describe, expect, it, vi, afterEach } from 'vitest';
import { mediaCoverSource, mediaCoverUrl } from '@/lib/cloud/media-cover';
import { GET } from '@/app/api/media/cover/route';
import { pdfCover } from '@/lib/cloud/pdf-cover';
import sharp from 'sharp';
import { existsSync } from 'node:fs';

const origin = 'https://example.supabase.co';
const source = origin+'/storage/v1/object/sign/creative-media/0350a0a1-567d-427e-a479-c3a385cd3da6/ccd3710c-594a-4c31-8cc0-3f0317213154?token=temporary-read-grant';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('private PDF cover rendering', () => {
  it('accepts only the existing exact Storage read capability and never an arbitrary URL', async () => {
    expect(mediaCoverSource(source, origin).href).toBe(source);
    expect(new URL(mediaCoverUrl(source, 'https://app.adport.test', origin)).pathname).toBe('/api/media/cover');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const invalid of ['http://127.0.0.1/private.pdf', 'https://untrusted.test/private.pdf', source.replace('/object/sign/', '/object/public/'), source.replace('?token=', '?other='), source+'&download=1', source.replace('/0350a0a1-567d-427e-a479-c3a385cd3da6/', '/not-a-project/')]) {
      expect((await GET(new Request('https://app.adport.test/api/media/cover?source='+encodeURIComponent(invalid)))).status).toBe(404);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forwards no credentials, refuses redirects and oversized or non-PDF source data', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not PDF', { status: 200 })); vi.stubGlobal('fetch', fetcher);
    const response = await GET(new Request('https://app.adport.test/api/media/cover?source='+encodeURIComponent(source)));
    expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(fetcher).toHaveBeenCalledWith(new URL(source), expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    fetcher.mockResolvedValue(new Response('tiny', { headers: { 'content-length': String(51 * 1024 * 1024) } }));
    expect((await GET(new Request('https://app.adport.test/api/media/cover?source='+encodeURIComponent(source)))).status).toBe(404);
  });
  it('renders the actual first page as a bounded PNG in an isolated worker', async () => {
    // Minimal valid PDF fixture, with exact byte offsets, not a source-file mutation.
    const drawing = '0.8 0.2 0.1 rg\n10 10 100 200 re f\n';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(drawing)} >>\nstream\n${drawing}endstream`];
    let pdf = '%PDF-1.7\n'; const offsets = [0];
    objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf); pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const image = await pdfCover(new Uint8Array(Buffer.from(pdf)));
    expect(Buffer.from(image).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    expect(Buffer.from(image).readUInt32BE(16)).toBeLessThanOrEqual(512);
    expect(Buffer.from(image).readUInt32BE(20)).toBeLessThanOrEqual(640);
    const width = Buffer.from(image).readUInt32BE(16), height = Buffer.from(image).readUInt32BE(20);
    const pixel = await sharp(image).extract({ left: Math.floor(width / 4), top: Math.floor(height / 2), width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(180); expect(pixel[1]).toBeLessThan(80); expect(pixel[2]).toBeLessThan(80);
    // CI builds first: exercise the same standalone package layout used on Vercel.
    if (existsSync('.pdf-renderer/worker.mjs')) {
      vi.stubEnv('NODE_ENV', 'production');
      expect(Buffer.from(await pdfCover(new Uint8Array(Buffer.from(pdf))))).toEqual(Buffer.from(image));
      vi.unstubAllEnvs();
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from(pdf), { headers: { 'content-type': 'application/pdf' } })));
    const response = await GET(new Request('https://app.adport.test/api/media/cover?source='+encodeURIComponent(source)));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer()).length).toBeGreaterThan(100);
  });
});

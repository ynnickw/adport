// @vitest-environment jsdom
import { webcrypto, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileContentType, uploadProjectFile } from '@/app/dashboard/assets/media-client';

const projectId = '11111111-1111-4111-8111-111111111111', mediaId = '22222222-2222-4222-8222-222222222222', origin = 'https://qa.supabase.co';
const bytes = new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
const file = { name: 'image.png', type: 'image/png', size: bytes.length, arrayBuffer: async () => bytes.buffer } as File;
const requests: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
let failTransfer = false;
class UploadRequest {
  upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
  timeout = 0; status = 204; method = ''; url = ''; headers: Record<string,string> = {};
  onload?: () => void; onerror?: () => void; ontimeout?: () => void; onabort?: () => void;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(key: string, value: string) { this.headers[key] = value; }
  send(body: unknown) { requests.push({ method: this.method, url: this.url, body, headers: this.headers }); if (failTransfer) this.onerror?.(); else { this.upload.onprogress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true }); this.onload?.(); } }
}
const progress = vi.fn();
beforeEach(() => {
  requests.length = 0; failTransfer = false; progress.mockReset(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('XMLHttpRequest', UploadRequest);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'POST' ? Response.json({ media_id: mediaId, upload_url: `${origin}/storage/v1/object/upload/sign/creative-media/${projectId}/${mediaId}?token=synthetic` }) : Response.json({ asset: { id: mediaId, name: file.name, content_type: file.type, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'READY' } })));
});
afterEach(() => vi.unstubAllGlobals());
const input = () => ({ projectId, storageOrigin: origin, file, acceptedTypes: ['image/png'], maxBytes: 50 * 1024 * 1024, progress });
describe('browser private-file transport', () => {
  it('binds exact SHA-256 and bytes, reports transfer progress and finalizes separately', async () => {
    const ready = vi.fn(); expect(await uploadProjectFile({ ...input(), ready })).toBe(mediaId);
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ id: mediaId, status: 'READY' }));
    const metadata = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(metadata).toEqual({ name: 'image.png', byte_length: bytes.length, content_type: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(requests).toHaveLength(1); expect(new Uint8Array(requests[0]!.body as ArrayBuffer)).toEqual(bytes);
    expect(requests[0]!.headers).not.toHaveProperty('authorization'); expect(requests[0]!.headers['x-upsert']).toBe('false');
    expect(progress).toHaveBeenCalledWith('Uploading', 100, mediaId);
    expect(vi.mocked(fetch).mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ media_id: mediaId }) });
  });
  it.each([`https://attacker.test/storage/v1/object/upload/sign/creative-media/${projectId}/${mediaId}`, `${origin}/storage/v1/object/upload/sign/creative-media/another-project/${mediaId}`])('rejects an upload capability outside the exact project/object path', async upload_url => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ media_id: mediaId, upload_url }));
    await expect(uploadProjectFile(input())).rejects.toThrow('destination'); expect(requests).toEqual([]);
  });
  it('never replays bytes or auto-finalizes an unconfirmed transfer', async () => {
    failTransfer = true;
    await expect(uploadProjectFile(input())).rejects.toThrow('Verify this upload');
    expect(requests).toHaveLength(1); expect(fetch).toHaveBeenCalledOnce(); expect(progress).toHaveBeenCalledWith('Uploading', 0, mediaId);
  });
  it('validates empty/oversized files before reservation and recognizes file-picker MIME aliases', async () => {
    await expect(uploadProjectFile({ ...input(), file: { ...file, size: 0 } as File })).rejects.toThrow('supported file'); expect(fetch).not.toHaveBeenCalled();
    expect(fileContentType({ name: 'recording.WAV', type: 'audio/x-wav' })).toBe('audio/wav'); expect(fileContentType({ name: 'clip.MP4', type: '' })).toBe('video/mp4');
    for (const type of ['', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream', 'text/csv']) expect(fileContentType({ name: 'Products.CSV', type })).toBe('text/csv');
    expect(fileContentType({ name: 'products.txt', type: 'text/plain' })).toBe('text/plain');
    expect(fileContentType({ name: 'products.csv', type: 'video/mp4' })).toBe('video/mp4');
  });
});

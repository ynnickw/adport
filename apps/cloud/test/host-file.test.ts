import { createHash } from 'node:crypto';
import { MAX_PROJECT_MEDIA_BYTES } from '@adport/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHostFile } from '@/lib/cloud/host-file';
import { ProjectMediaLibrary } from '@/lib/cloud/media';

const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const source = { file_id: 'file_fixture', download_url: 'https://files.oaiusercontent.com/file-fixture?sig=private-capability', file_name: 'attachment.pdf', mime_type: 'application/pdf' };
afterEach(() => vi.unstubAllGlobals());

describe('host-provided attachment byte transport', () => {
  it('validates CSV host attachments by name or declared type without exposing the download capability', async () => {
    const csv = Buffer.from('sku_id\n00001\n');
    const fetcher = vi.fn(async () => new Response(csv));
    for (const file of [{ file_name: 'products.csv', mime_type: 'application/octet-stream' }, { file_name: 'Products', mime_type: 'text/csv' }]) {
      const result = await readHostFile({ ...source, ...file }, fetcher);
      expect(result).toMatchObject({ contentType: 'text/csv', sha256: createHash('sha256').update(csv).digest('hex') });
      expect(Buffer.from(result.bytes)).toEqual(csv);
    }
  });
  it('downloads original bytes without credentials, redirects or caching and derives actual MIME/hash', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) } }));
    const file = await readHostFile({ ...source, file_name: '../folder\\attachment.pdf', mime_type: 'text/html' }, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual([source.download_url, expect.objectContaining({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit' })]);
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('headers');
    expect(file).toMatchObject({ name: '.._folder_attachment.pdf', contentType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(Buffer.from(file.bytes)).toEqual(bytes);
  });

  it.each(['http://files.oaiusercontent.com/file', 'https://files.oaiusercontent.com.attacker.test/file', 'https://attacker.files.oaiusercontent.com/file', 'https://files.oaiusercontent.com:8443/file', 'https://user:secret@files.oaiusercontent.com/file', 'https://127.0.0.1/file', 'file:///etc/passwd', 'https://files.oaiusercontent.com/file#fragment'])('rejects non-native origins before a network request: %s', async download_url => {
    const fetcher = vi.fn();
    await expect(readHostFile({ ...source, download_url }, fetcher)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([206, 302, 403])('does not follow redirects, retry or return native error bodies: HTTP%s', async status => {
    const fetcher = vi.fn(async () => new Response('private-capability', { status }));
    const error = await readHostFile(source, fetcher).catch(error => error);
    expect(error.code).toBe('PROVIDER_ERROR'); expect(JSON.stringify(error.toJSON())).not.toContain('private-capability'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels oversized streaming downloads, checks length and sanitizes network errors', async () => {
    let canceled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_PROJECT_MEDIA_BYTES + 1)); }, cancel() { canceled = true; } });
    await expect(readHostFile(source, async () => new Response(body))).rejects.toThrow('50 MiB'); expect(canceled).toBe(true);
    await expect(readHostFile(source, async () => new Response(bytes, { headers: { 'content-length': String(bytes.length + 1) } }))).rejects.toThrow('incomplete');
    const error = await readHostFile(source, async () => { throw new Error(source.download_url); }).catch(error => error);
    expect(JSON.stringify(error.toJSON())).not.toContain('private-capability');
    await expect(readHostFile(source, async () => new Response(bytes, { headers: { 'content-length': String(MAX_PROJECT_MEDIA_BYTES + 1) } }))).rejects.toThrow('50 MiB');
  });

  it('inspects without storage, rejects malformed images and checks read authorization before downloading', async () => {
    const download = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', download);
    const reader = new ProjectMediaLibrary({ organizationId: '00000000-0000-4000-8000-000000000001', role: 'owner', scopes: ['tools:read'] });
    const result = await reader.inspectFile(source);
    expect(result).toMatchObject({ file_id: source.file_id, metadata: { name: source.file_name, content_type: 'application/pdf', byte_length: bytes.length } });
    expect(JSON.stringify(result)).not.toContain('download_url'); expect(JSON.stringify(result)).not.toContain('private-capability');
    const denied = new ProjectMediaLibrary({ organizationId: reader.scopeId, role: 'owner', scopes: [] });
    await expect(denied.inspectFile(source)).rejects.toThrow('tools:read'); expect(download).toHaveBeenCalledOnce();
    download.mockImplementation(async () => new Response(Buffer.from([137,80,78,71,13,10,26,10,0,0])));
    await expect(reader.inspectFile({ ...source, file_name: 'fake.png' })).rejects.toThrow('decoded');
  });
});

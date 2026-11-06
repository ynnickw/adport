import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectMediaLibrary } from '@/lib/cloud/media';

const mocks = vi.hoisted(() => ({ query: vi.fn(), signed: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => mocks.query }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: mocks.signed, download: mocks.download }) } }) }));
const project = '203c14b1-c908-4632-9aa7-1be5de4ae9b0', id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('sku_id\r\n00012\r\n'), sha256 = createHash('sha256').update(bytes).digest('hex');
const row = { id, organizationId: project, name: 'Product IDs', objectPath: project + '/' + id, contentType: 'text/csv', byteLength: bytes.length, sha256, status: 'ready', deletedAt: null, createdAt: new Date(), metadataVersion: 1 };
const library = () => new ProjectMediaLibrary({ organizationId: project, scopes: ['tools:read', 'tools:write'] });
beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue([row]);
  mocks.signed.mockReset().mockResolvedValue({ data: { signedUrl: 'https://qa.supabase.co/storage/v1/object/sign/creative-media/' + row.objectPath + '?token=fixture&download=' }, error: null });
  mocks.download.mockReset().mockResolvedValue({ data: new Blob([bytes], { type: 'text/csv' }), error: null });
});
describe('private CSV library reads', () => {
  it('uses attachment downloads and never creates PDF/image cover URLs for CSV', async () => {
    const asset = await library().get(id);
    expect(mocks.signed).toHaveBeenCalledWith(row.objectPath, 900, { download: true });
    expect(asset).toMatchObject({ id, name: 'Product IDs', content_type: 'text/csv', sha256, status: 'READY' });
    expect(asset).not.toHaveProperty('preview_cover_url');
  });
  it('revalidates renamed CSV bytes and checksum for provider reads without server paths', async () => {
    const file = await library().read({ media_id: id, expected_sha256: sha256 }, { contentTypes: ['text/csv'] });
    expect(file).toMatchObject({ name: 'Product IDs', contentType: 'text/csv', sha256 });expect(Buffer.from(file.bytes)).toEqual(bytes);
    await expect(library().read({ media_id: id, expected_sha256: sha256 }, { contentTypes: ['video/mp4'] })).rejects.toThrow('supported media');
    mocks.download.mockResolvedValue({ data: new Blob([Buffer.from('sku_id\n00013\n')]), error: null });
    await expect(library().read({ media_id: id, expected_sha256: sha256 })).rejects.toThrow();
  });
  it('includes PDF and CSV in the project-scoped Documents filter and advertises CSV uploads', async () => {
    const result = await library().list({ limit: 24, kind: 'document' });
    const [parts, ...values] = mocks.query.mock.calls[0]!;
    expect(parts.join('?')).toContain("content_type in ('application/pdf', 'text/csv')");
    expect(parts.join('?')).toContain('organization_id =');expect(values).toContain(project);
    expect(result.upload_config.content_types).toContain('text/csv');expect(result.assets).toHaveLength(1);
  });
});

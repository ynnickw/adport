import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cloudTool, uploadCloudMedia } from '../src/cloud-media.js';

const roots: string[] = [], id = '11111111-1111-4111-8111-111111111111';
const options = { cloudUrl: 'https://app.adport.test', apiKeyEnv: 'ADPORT_MEDIA_TEST_KEY' };
afterEach(async () => { delete process.env.ADPORT_MEDIA_TEST_KEY; await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function file() { const root = await mkdtemp(join(tmpdir(), 'adport-media-cli-')); roots.push(root); const path = join(root, 'test.png'); await writeFile(path, Buffer.from([137,80,78,71,13,10,26,10,1])); process.env.ADPORT_MEDIA_TEST_KEY = 'adp_fixture'; return path; }

describe('headless Cloud media CLI orchestration', () => {
  it('previews without sending bytes and completes approved raw transfer plus guarded finalization without a browser', async () => {
    const path = await file(), calls: { url: string; input: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, input = {}) => {
      calls.push({ url: String(url), input });
      if (String(url).includes('supabase.co')) { expect(new Headers(input.headers).has('authorization')).toBe(false); return new Response('', { status: 200 }); }
      const body = JSON.parse(String(input.body));
      expect(input.redirect).toBe('error');
      if (String(url).endsWith('/media_prepare_upload')) return Response.json(body.pending_operation_id ? { status: 'applied', applied: true, result: { resourceIds: [id], details: { media_id: id, upload_url: `https://fixture.supabase.co/storage/v1/object/upload/sign/creative-media/project/${id}?token=private`, method: 'PUT' } } } : { status: 'pending_validation', pending_operation_id: 'prepare-token' });
      return Response.json(body.pending_operation_id ? { status: 'applied', applied: true, result: { resourceIds: [id] } } : { status: 'pending_validation', pending_operation_id: 'finalize-token' });
    };
    expect(await uploadCloudMedia(path, options, fetchImpl)).toMatchObject({ status: 'pending_validation' }); expect(calls).toHaveLength(1);
    const result = await uploadCloudMedia(path, { ...options, pendingOperationId: 'prepare-token' }, fetchImpl);
    expect(result).toMatchObject({ status: 'applied' }); expect(calls).toHaveLength(5);
    expect(calls[2]!.input.method).toBe('PUT'); expect(calls[2]!.input.body).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(String(calls[3]!.input.body))).not.toHaveProperty('pending_operation_id');
    expect(JSON.parse(String(calls[4]!.input.body)).pending_operation_id).toBe('finalize-token');
  });

  it('rejects unexpected upload destinations and symlinks before transferring local bytes', async () => {
    const path = await file(), calls: string[] = [], fake: typeof fetch = async url => { calls.push(String(url)); return Response.json({ status: 'applied', applied: true, result: { resourceIds: [id], details: { media_id: id, upload_url: `https://evil.test/storage/v1/object/upload/sign/creative-media/${id}`, method: 'PUT' } } }); };
    await expect(uploadCloudMedia(path, { ...options, pendingOperationId: 'token' }, fake)).rejects.toThrow('destination'); expect(calls).toHaveLength(1);
    const link = `${path}.link`; await symlink(path, link); await expect(uploadCloudMedia(link, options, fake)).rejects.toThrow('symbolic link'); expect(calls).toHaveLength(1);
  });

  it('never prints or forwards credentials through insecure origins, URL credentials, or OAuth default-project routing', async () => {
    process.env.ADPORT_MEDIA_TEST_KEY = 'adp_fixture';
    for (const cloudUrl of ['http://example.test', 'https://user:pass@example.test', 'https://example.test/path']) await expect(cloudTool('media_get', {}, { ...options, cloudUrl })).rejects.toThrow('HTTPS origin');
    process.env.ADPORT_MEDIA_TEST_KEY = 'oauth-fixture'; await expect(cloudTool('media_get', {}, options)).rejects.toThrow('project-scoped');
  });
});

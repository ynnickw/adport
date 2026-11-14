import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { cleanupDeletedProjectMedia, ProjectMediaLibrary } from '@/lib/cloud/media';
import { resolveMembership } from '@/lib/cloud/repository';
import { PostgresAuditStore, PostgresPendingStore } from '@/lib/cloud/repository';
import { AdportError, createContext, DEFAULT_POLICY, MEDIA_UPLOAD_PART_BYTES, PolicyEngine } from '@adport/core';
import { createMcpServer } from '@adport/mcp';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('project media signed-upload boundary', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonymous = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [], projects: string[] = [];
  let owner: ProjectMediaLibrary, other: ProjectMediaLibrary;
  let bytes: Buffer<ArrayBuffer>, sha256: string;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname)) throw new Error('Media integration tests require local Supabase.');
    for (let index = 0; index < 3; index++) {
      const result = await admin.auth.admin.createUser({ email: `media-${randomUUID()}@example.test`, password: 'Local-Media-Test-Passw0rd!', email_confirm: true });
      if (result.error || !result.data.user) throw result.error ?? new Error('User creation failed');
      users.push(result.data.user.id); projects.push((await resolveMembership(result.data.user.id)).organizationId);
    }
    owner = new ProjectMediaLibrary({ organizationId: projects[0]!, userId: users[0]!, role: 'owner', scopes: ['tools:read', 'tools:write'] });
    other = new ProjectMediaLibrary({ organizationId: projects[1]!, userId: users[1]!, role: 'owner', scopes: ['tools:read', 'tools:write'] });
    bytes = await sharp({ create: { width: 1200, height: 628, channels: 3, background: '#ff6600' } }).png().toBuffer();
    sha256 = createHash('sha256').update(bytes).digest('hex');
  });
  afterAll(async () => {
    if (projects.length) {
      for (const project of projects) {
        const { data } = await admin.storage.from('creative-media').list(project, { limit: 1000 });
        if (data?.length) await admin.storage.from('creative-media').remove(data.map(file => `${project}/${file.name}`));
      }
      await db()`delete from public.organizations where id in ${db()(projects)}`;
      await db()`delete from private.creative_media_cleanup where project_id in ${db()(projects)}`;
    }
    for (const user of users) await admin.auth.admin.deleteUser(user);
    await closeDbForTests();
  });

  it('uploads, verifies and reads immutable bytes while denying anonymous and cross-project access', async () => {
    const metadata = { name: 'private-creative.png', content_type: 'image/png' as const, byte_length: bytes.byteLength, sha256 };
    const prepared = await owner.beginUpload(metadata);
    await expect(owner.read({ media_id: prepared.media_id, expected_sha256: sha256 })).rejects.toThrow('Finish and verify');
    const uploaded = await fetch(prepared.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png', 'x-upsert': 'false' } });
    expect(uploaded.ok).toBe(true);
    await expect(other.finalize(prepared.media_id)).rejects.toThrow('selected project');
    await expect(owner.finalize(prepared.media_id)).resolves.toMatchObject({ media_id: prepared.media_id, sha256, status: 'ready' });
    await expect(owner.finalize(prepared.media_id)).resolves.toMatchObject({ status: 'ready' });
    const found = await owner.list({ limit: 10 });
    expect(found.upload_config).toMatchObject({ project_id: projects[0], storage_origin: new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin, max_bytes: 50 * 1024 * 1024, content_types: expect.arrayContaining(['image/png', 'video/mp4']) });
    expect(found.assets.find(asset => asset.id === prepared.media_id)).toMatchObject({ sha256, width: 1200, height: 628, byte_length: bytes.byteLength, status: 'READY' });
    const read = await owner.read({ media_id: prepared.media_id, expected_sha256: sha256 });
    expect(Buffer.from(read.bytes).equals(bytes)).toBe(true);
    await expect(other.read({ media_id: prepared.media_id, expected_sha256: sha256 })).rejects.toThrow('selected project');
    expect((await other.list({ limit: 10 })).assets.some(asset => asset.id === prepared.media_id)).toBe(false);
    await expect(owner.read({ media_id: prepared.media_id, expected_sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    const source = { media_id: prepared.media_id, expected_sha256: sha256 };
    const providerGrant = await owner.providerUrl(source, { contentTypes: ['image/png'] });
    expect(providerGrant.sha256).toBe(sha256);
    expect(Date.parse(providerGrant.expires_at)).toBeGreaterThan(Date.now() + 3_590_000);
    expect(Buffer.from(await (await fetch(providerGrant.url)).arrayBuffer()).equals(bytes)).toBe(true);
    await expect(other.providerUrl(source)).rejects.toThrow('selected project');
    await expect(owner.providerUrl({ ...source, expected_sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    const reader = new ProjectMediaLibrary({ organizationId: projects[0]!, userId: users[0]!, role: 'owner', scopes: ['tools:read'] });
    await expect(reader.providerUrl(source)).rejects.toThrow();
    const [row] = await db()<Array<{ objectPath: string }>>`select object_path from private.creative_media where id = ${prepared.media_id}`;
    expect((await anonymous.storage.from('creative-media').download(row!.objectPath)).error).toBeTruthy();
    // An attacker cannot override the upsert=false grant with a request header.
    const replaced = await fetch(prepared.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png', 'x-upsert': 'true' } });
    expect(replaced.ok).toBe(false);
  });

  it('recovers interrupted upload references through scoped, paginated read-only MCP searches', async () => {
    const query = `interrupted-${randomUUID()}`;
    const metadata = { name: `${query}.png`, content_type: 'image/png' as const, byte_length: bytes.length, sha256 };
    const pending = [await owner.beginUpload(metadata), await owner.beginUpload(metadata)];
    const failed = await owner.beginUpload(metadata), foreign = await other.beginUpload(metadata);
    await db()`update private.creative_media set status = 'failed' where id = ${failed.media_id}`;
    const reader = await runtime(0, ['tools:read']);
    expect((await call(reader, 'media_list', { query, limit: 100 })).assets).toEqual([]);
    const first = await call(reader, 'media_list', { query, status: 'PROCESSING', limit: 1 });
    expect(first.assets).toHaveLength(1); expect(first.truncated).toBe(true);
    const second = await call(reader, 'media_list', { query, status: 'PROCESSING', limit: 1, cursor: first.next_cursor });
    expect(second.assets).toHaveLength(1); expect(second.truncated).toBe(false);
    const recovered = [...first.assets, ...second.assets];
    expect(recovered.map(asset => asset.id).sort()).toEqual(pending.map(asset => asset.media_id).sort());
    expect(recovered.every(asset => asset.status === 'PROCESSING' && asset.sha256 === sha256 && !asset.preview_url && !asset.upload)).toBe(true);
    expect([...first.creatives, ...second.creatives].every(creative => creative.media.length === 0)).toBe(true);
    const failures = await call(reader, 'media_list', { query, status: 'FAILED', limit: 100 });
    expect(failures.assets).toMatchObject([{ id: failed.media_id, status: 'FAILED', sha256 }]);
    expect(failures.assets[0]).not.toHaveProperty('preview_url');
    expect([...recovered, ...failures.assets].some(asset => asset.id === foreign.media_id)).toBe(false);
    const detail = await call(reader, 'media_get', { media_id: recovered[0]!.id });
    expect(detail.asset.upload).toMatchObject({ part_count: 1, received_parts: [] });
    await expect(call(reader, 'media_list', { status: 'DELETED' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('distinguishes a complete direct upload from missing MCP parts without finalizing or extending it', async () => {
    const grant = await owner.beginUpload({ name: 'unknown-direct-put.png', content_type: 'image/png', byte_length: bytes.length, sha256 });
    const reader = await runtime(0, ['tools:read']);
    const missing = await call(reader, 'media_get', { media_id: grant.media_id });
    expect(missing.asset.upload).toMatchObject({ expired: false, parts_state: 'CHECKED', received_parts: [], whole_file: { status: 'NOT_FOUND' } });
    const transferred = await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: grant.headers });
    expect(transferred.ok).toBe(true);
    const present = await call(reader, 'media_get', { media_id: grant.media_id });
    expect(present.asset).toMatchObject({ status: 'PROCESSING', sha256, upload: { expired: false, parts_state: 'CHECKED', received_parts: [], whole_file: { status: 'PRESENT_UNVERIFIED', byte_length: bytes.length, size_matches_reservation: true } } });
    expect(present.asset).not.toHaveProperty('preview_url');
    await db()`update private.creative_media set expires_at = now() - interval '1 minute' where id = ${grant.media_id}`;
    const [before] = await db()`select status, expires_at, metadata_version from private.creative_media where id = ${grant.media_id}`;
    const expired = await call(reader, 'media_get', { media_id: grant.media_id });
    expect(expired.asset).toMatchObject({ status: 'PROCESSING', upload: { expired: true, whole_file: { status: 'PRESENT_UNVERIFIED', byte_length: bytes.length } } });
    const [after] = await db()`select status, expires_at, metadata_version from private.creative_media where id = ${grant.media_id}`;
    expect(after).toEqual(before);
    await expect(owner.read({ media_id: grant.media_id, expected_sha256: sha256 })).rejects.toThrow('Finish and verify');
    await expect(other.get(grant.media_id)).rejects.toThrow('selected project');
  });

  it.each(['parts', 'whole'] as const)('keeps %s metadata failures distinct from an absent upload', async unavailable => {
    const grant = await owner.beginUpload({ name: 'upload-metadata-check.png', content_type: 'image/png', byte_length: bytes.length, sha256 });
    expect((await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: grant.headers })).ok).toBe(true);
    const reader = await runtime(0, ['tools:read']);
    const originalFetch = globalThis.fetch;
    const interception = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname;
      const selected = unavailable === 'whole' ? path === `/storage/v1/object/info/creative-media/${projects[0]}/${grant.media_id}` : path === '/storage/v1/object/list/creative-media';
      return selected ? Promise.resolve(Response.json({ statusCode: '403', error: 'AccessDenied', message: 'private-storage-diagnostic' }, { status: 403 })) : originalFetch(input, init);
    });
    try {
      const result = await call(reader, 'media_get', { media_id: grant.media_id });
      expect(result.asset.status).toBe('PROCESSING');
      expect(result.asset.upload).toMatchObject({ parts_state: unavailable === 'parts' ? 'UNAVAILABLE' : 'CHECKED', received_parts: [], whole_file: { status: unavailable === 'whole' ? 'UNAVAILABLE' : 'PRESENT_UNVERIFIED' } });
      expect(JSON.stringify(result)).not.toContain('private-storage-diagnostic');
      expect(result.asset).not.toHaveProperty('preview_url');
    } finally { interception.mockRestore(); }
  });

  it('reports mismatched stored sizes and failed reservations without certifying their bytes', async () => {
    const grant = await owner.beginUpload({ name: 'partial-direct-put.png', content_type: 'image/png', byte_length: bytes.length, sha256 });
    expect((await fetch(grant.upload_url, { method: 'PUT', body: bytes.subarray(0, 8), headers: grant.headers })).ok).toBe(true);
    const reader = await runtime(0, ['tools:read']);
    const partial = await call(reader, 'media_get', { media_id: grant.media_id });
    expect(partial.asset).toMatchObject({ status: 'PROCESSING', sha256, upload: { whole_file: { status: 'PRESENT_UNVERIFIED', byte_length: 8, size_matches_reservation: false } } });
    await db()`update private.creative_media set status = 'failed' where id = ${grant.media_id}`;
    const failed = await call(reader, 'media_get', { media_id: grant.media_id });
    expect(failed.asset).toMatchObject({ status: 'FAILED', upload: { whole_file: { status: 'PRESENT_UNVERIFIED', byte_length: 8, size_matches_reservation: false } } });
    expect(failed.asset).not.toHaveProperty('preview_url');
    await expect(owner.read({ media_id: grant.media_id, expected_sha256: sha256 })).rejects.toThrow('Finish and verify');
  });

  it('rejects uploaded bytes that differ from the reserved checksum and never lists them as ready', async () => {
    const prepared = await owner.beginUpload({ name: 'wrong-checksum.png', content_type: 'image/png', byte_length: bytes.byteLength, sha256: '0'.repeat(64) });
    expect((await fetch(prepared.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png', 'x-upsert': 'false' } })).ok).toBe(true);
    await expect(owner.finalize(prepared.media_id)).rejects.toThrow('SHA-256');
    expect((await owner.list({ limit: 100 })).assets.some(asset => asset.id === prepared.media_id)).toBe(false);
  });

  it('queues project deletion until signed grants expire, then removes the private objects', async () => {
    const projectId = projects[2]!;
    const library = new ProjectMediaLibrary({ organizationId: projectId, userId: users[2]!, role: 'owner', scopes: ['tools:read', 'tools:write'] });
    const prepared = await library.beginUpload({ name: 'deleted-project.png', content_type: 'image/png', byte_length: bytes.byteLength, sha256 });
    expect((await fetch(prepared.upload_url, { method: 'PUT', body: bytes, headers: { 'content-type': 'image/png' } })).ok).toBe(true);
    const [file] = await db()<Array<{ objectPath: string }>>`select object_path from private.creative_media where id = ${prepared.media_id}`;
    const rt = await runtime(2), partial = await apply(rt, 'media_prepare_upload', { name: 'deleted-project-part.png', content_type: 'image/png', byte_length: bytes.length, sha256 });
    await apply(rt, 'media_upload_part', { media_id: partial.result.details.media_id, expected_sha256: sha256, part_index: 0, part_sha256: sha256, data_base64: bytes.toString('base64') });
    await db()`delete from public.organizations where id = ${projectId}`;
    const [job] = await db()<Array<{ notBefore: Date }>>`select not_before from private.creative_media_cleanup where project_id = ${projectId}`;
    expect(job!.notBefore.getTime()).toBeGreaterThan(Date.now() + 2 * 60 * 60_000);
    await cleanupDeletedProjectMedia();
    expect((await admin.storage.from('creative-media').download(file!.objectPath)).data).toBeTruthy();
    // Only local fixture setup can move the deadline; the backend has no UPDATE grant.
    const fixtureAdmin = postgres(process.env.SUPABASE_DB_URL!, { max: 1 });
    try { await fixtureAdmin`update private.creative_media_cleanup set not_before = now() - interval '1 second' where project_id = ${projectId}`; }
    finally { await fixtureAdmin.end(); }
    await cleanupDeletedProjectMedia();
    expect(await db()`select project_id from private.creative_media_cleanup where project_id = ${projectId}`).toHaveLength(0);
    expect((await admin.storage.from('creative-media').download(file!.objectPath)).error).toBeTruthy();
    expect((await admin.storage.from('creative-media').list(projectId)).data).toEqual([]);
  });

  async function runtime(index = 0, scopes = ['tools:read', 'tools:write']) {
    const principal = { organizationId: projects[index]!, userId: users[index]!, role: 'owner' as const, scopes };
    return createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PostgresPendingStore(principal), new PostgresAuditStore(principal)), media: new ProjectMediaLibrary(principal) });
  }
  async function call(rt: Awaited<ReturnType<typeof runtime>>, tool: string, input: Record<string, unknown>): Promise<any> { return rt.registry.call(tool, input, rt.ctx); }
  async function apply(rt: Awaited<ReturnType<typeof runtime>>, tool: string, input: Record<string, unknown>) {
    const preview = await call(rt, tool, input); expect(preview.applied).toBe(false);
    return call(rt, tool, { ...input, pending_operation_id: preview.pending_operation_id });
  }

  it('imports a large host attachment through MCP with exact bytes and the normal project approval gate', async () => {
    const nativeBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024 + 31, 32), Buffer.from('\n%%EOF\n')]);
    const checksum = createHash('sha256').update(nativeBytes).digest('hex');
    const file = { file_id: 'file_private_fixture', download_url: 'https://files.oaiusercontent.com/file-fixture?sig=private-fixture', file_name: 'native-host-attachment.pdf', mime_type: 'application/pdf' };
    let current = nativeBytes;
    const originalFetch = globalThis.fetch, download = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url) === file.download_url ? new Response(current) : originalFetch(url, init));
    const rt = await runtime(), server = createMcpServer({ runtime: rt }), client = new Client({ name: 'host-file-import-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const invoke = async (name: string, input: Record<string, unknown>): Promise<any> => { const result = await client.callTool({ name, arguments: input }); if (result.isError) throw new Error((result.content as any[]).find(item => item.type === 'text')?.text ?? 'MCP fixture error'); return result.structuredContent; };
    const count = async () => (await db()<Array<{ count: string }>>`select count(*)::text as count from private.creative_media where organization_id = ${projects[0]!}`)[0]!.count;
    try {
      const before = await count(), inspected = await invoke('media_inspect_file', { file });
      expect(inspected.metadata).toMatchObject({ byte_length: nativeBytes.length, sha256: checksum, content_type: 'application/pdf' });
      expect(JSON.stringify(inspected)).not.toContain('private-fixture'); expect(await count()).toBe(before);
      const input = { ...inspected.metadata, file }, preview = await invoke('media_import_file', input);
      expect(preview.applied).toBe(false); expect(await count()).toBe(before);
      current = Buffer.from(nativeBytes); current[current.length - 1] = 33;
      await expect(invoke('media_import_file', { ...input, pending_operation_id: preview.pending_operation_id })).rejects.toThrow('SHA-256');
      expect(await count()).toBe(before);
      current = nativeBytes;
      const fresh = await invoke('media_import_file', input), imported = await invoke('media_import_file', { ...input, pending_operation_id: fresh.pending_operation_id }), media_id = imported.result.details.media_id;
      expect(imported).toMatchObject({ applied: true, result: { details: { sha256: checksum, status: 'ready', asset: { byte_length: nativeBytes.length } } } });
      expect(Number(await count())).toBe(Number(before) + 1);
      const found = await invoke('media_get', { media_id }); expect(found.asset).toMatchObject({ status: 'READY', sha256: checksum });
      expect(Buffer.from((await owner.read({ media_id, expected_sha256: checksum })).bytes)).toEqual(nativeBytes);
      await expect(other.get(media_id)).rejects.toThrow('selected project');
      const reader = await runtime(0, ['tools:read']); await expect(call(reader, 'media_import_file', input)).rejects.toThrow('tools:write');
      const audits = await db()<Array<{ event: string }>>`select event from public.audit_events where organization_id = ${projects[0]!} and tool = 'media_import_file'`;
      expect(audits).toEqual(expect.arrayContaining([{ event: 'validated' }, { event: 'applied' }]));
      expect(download.mock.calls.filter(([url]) => String(url) === file.download_url).length).toBeGreaterThanOrEqual(5);
    } finally { download.mockRestore(); await Promise.allSettled([client.close(), server.close()]); }
  });

  it('stores and transfers a checksum-bound PDF without rendering it as audio', async () => {
    const rt = await runtime(), pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'), checksum = createHash('sha256').update(pdf).digest('hex');
    const input = { name: 'private-document.pdf', content_type: 'application/pdf', byte_length: pdf.length, sha256: checksum, data_base64: pdf.toString('base64') };
    const result = await apply(rt, 'media_upload', input), media_id = result.result.resourceIds[0];
    const found = await call(rt, 'media_get', { media_id });
    expect(found.asset).toMatchObject({ content_type: 'application/pdf', sha256: checksum, status: 'READY' });
    expect(Buffer.from(await (await fetch(found.asset.preview_url)).arrayBuffer())).toEqual(pdf);
    expect(Buffer.from((await owner.read({ media_id, expected_sha256: checksum }, { contentTypes: ['application/pdf'] })).bytes).equals(pdf)).toBe(true);
    const gallery = await call(rt, 'media_list', { limit: 100 });
    const preview = gallery.creatives.find((v: any) => v.id === media_id).media;
    // Local HTTP Storage grants are usable headlessly, but not in an HTTPS widget.
    expect(preview).toEqual([]);
    expect(new URL(found.asset.preview_cover_url).pathname).toBe('/api/media/cover');
    const original = new URL(found.asset.preview_url);
    expect(original.origin).toBe(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin);
    expect(original.pathname).toBe(`/storage/v1/object/sign/creative-media/${projects[0]}/${media_id}`);
    expect(original.searchParams.has('token')).toBe(true);
    await expect(other.read({ media_id, expected_sha256: checksum })).rejects.toThrow('selected project');
  });

  it('uploads, downloads, renames and deletes entirely through guarded agent tools with real private Storage', async () => {
    const rt = await runtime(), second = await runtime(1), readonly = await runtime(0, ['tools:read']);
    const input = { name: 'agent-inline.png', content_type: 'image/png', byte_length: bytes.byteLength, sha256, data_base64: bytes.toString('base64') };
    const before = await db()`select id from private.creative_media where organization_id = ${projects[0]!}`;
    const preview = await call(rt, 'media_upload', input);
    expect(await db()`select id from private.creative_media where organization_id = ${projects[0]!}`).toHaveLength(before.length);
    await expect(call(rt, 'media_upload', { ...input, name: 'other.png', pending_operation_id: preview.pending_operation_id })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(call(readonly, 'media_upload', input)).rejects.toThrow('tools:write');
    const uploaded = await call(rt, 'media_upload', { ...input, pending_operation_id: preview.pending_operation_id }), media_id = uploaded.result.resourceIds[0];
    expect(uploaded.result.details).toMatchObject({ media_id, sha256, status: 'ready' });
    expect(uploaded.result.details.asset).toMatchObject({ id: media_id, sha256, status: 'READY', width: 1200, height: 628 });
    const found = await call(rt, 'media_get', { media_id });
    expect(Buffer.from(await (await fetch(found.asset.preview_url)).arrayBuffer()).equals(bytes)).toBe(true);
    await expect(call(second, 'media_get', { media_id })).rejects.toThrow('selected project');
    const rename = { media_id, expected_sha256: sha256, expected_name: input.name, name: 'agent-renamed.png' };
    expect((await apply(rt, 'media_rename', rename)).result.details.asset.name).toBe(rename.name);
    await expect(call(rt, 'media_rename', rename)).rejects.toThrow('name changed');
    const deleted = await apply(rt, 'media_delete', { media_id, expected_sha256: sha256, expected_name: rename.name });
    expect(deleted.result.details).toMatchObject({ status: 'deleted', storage_removed: true });
    expect((await call(rt, 'media_get', { media_id })).asset.status).toBe('DELETED');
    await expect(owner.read({ media_id, expected_sha256: sha256 })).rejects.toThrow('deleted');
    expect((await fetch(found.asset.preview_url)).ok).toBe(false);
    const audits = await db()<Array<{ tool: string; event: string }>>`select tool, event from public.audit_events where organization_id = ${projects[0]!} and tool in ('media_upload','media_rename','media_delete')`;
    for (const tool of ['media_upload','media_rename','media_delete']) expect(audits).toEqual(expect.arrayContaining([{ tool, event: 'validated' }, { tool, event: 'applied' }]));
  });

  it('prepares and finalizes a raw upload with exact bytes while retaining cross-project and checksum boundaries', async () => {
    const rt = await runtime(), second = await runtime(1), metadata = { name: 'agent-prepared.png', content_type: 'image/png', byte_length: bytes.byteLength, sha256 };
    const prepared = await apply(rt, 'media_prepare_upload', metadata), grant = prepared.result.details;
    expect(grant).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png', 'x-upsert': 'false' } });
    expect((await call(rt, 'media_get', { media_id: grant.media_id })).asset).toMatchObject({ status: 'PROCESSING' });
    expect((await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: grant.headers })).ok).toBe(true);
    const args = { media_id: grant.media_id, expected_sha256: sha256 };
    await expect(call(second, 'media_finalize_upload', args)).rejects.toThrow('selected project');
    await expect(call(rt, 'media_finalize_upload', { ...args, expected_sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
    const preview = await call(rt, 'media_finalize_upload', args);
    expect((await call(rt, 'media_get', { media_id: grant.media_id })).asset.status).toBe('PROCESSING');
    const final = await call(rt, 'media_finalize_upload', { ...args, pending_operation_id: preview.pending_operation_id });
    expect(final.result.details).toMatchObject({ media_id: grant.media_id, sha256, status: 'ready' });
    expect(final.result.details.asset).toMatchObject({ status: 'READY', sha256, id: grant.media_id });
    expect(Buffer.from((await owner.read(args)).bytes).equals(bytes)).toBe(true);
    const writer = await runtime(0, ['tools:write']);
    const renamed = await apply(writer, 'media_rename', { ...args, expected_name: metadata.name, name: 'write-only-renamed.png' });
    expect(renamed.result.details.asset).not.toHaveProperty('preview_url');
    await expect(call(writer, 'media_get', { media_id: grant.media_id })).rejects.toThrow('tools:read');
  });

  it('completes an upload through MCP tool calls and raw HTTP without reading or rendering any UI resource', async () => {
    const rt = await runtime(), server = createMcpServer({ runtime: rt, scopes: ['tools:read','tools:write'] }), host = new Client({ name: 'headless-media-integration', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(clientTransport), server.connect(serverTransport)]);
    const invoke = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await host.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true); return result.structuredContent;
    };
    try {
      const args = { name: 'mcp-no-ui.png', content_type: 'image/png', byte_length: bytes.byteLength, sha256 };
      const preview = await invoke('media_prepare_upload', args);
      const applied = await invoke('media_prepare_upload', { ...args, pending_operation_id: preview.pending_operation_id }), grant = applied.result.details;
      expect((await fetch(grant.upload_url, { method: 'PUT', body: bytes, headers: grant.headers })).ok).toBe(true);
      const selected = { media_id: grant.media_id, expected_sha256: sha256 }, finalized = await invoke('media_finalize_upload', selected);
      expect((await invoke('media_finalize_upload', { ...selected, pending_operation_id: finalized.pending_operation_id })).result.details.asset.status).toBe('READY');
      expect((await invoke('media_get', { media_id: grant.media_id })).asset.sha256).toBe(sha256);
    } finally { await host.close(); await server.close(); }
  });

  it('uploads out-of-order immutable parts entirely through MCP and verifies exact assembled bytes with no client HTTP transfer', async () => {
    const rt = await runtime(), second = await runtime(1), readonly = await runtime(0, ['tools:read']);
    const server = createMcpServer({ runtime: rt, scopes: ['tools:read','tools:write'] }), host = new Client({ name: 'mcp-only-part-upload', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(clientTransport), server.connect(serverTransport)]);
    const invoke = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const result = await host.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true); return result.structuredContent;
    };
    const approve = async (name: string, args: Record<string, unknown>) => {
      const preview = await invoke(name, args);
      return invoke(name, { ...args, pending_operation_id: preview.pending_operation_id });
    };
    const video = Buffer.alloc(MEDIA_UPLOAD_PART_BYTES * 2 + 31, 97);
    video.writeUInt32BE(24, 0); video.write('ftypisom', 4);
    const checksum = createHash('sha256').update(video).digest('hex');
    const metadata = { name: 'mcp-parts.mp4', content_type: 'video/mp4', byte_length: video.length, sha256: checksum };
    try {
      const prepared = await approve('media_prepare_upload', metadata), media_id = prepared.result.details.media_id;
      expect(prepared.result.details.mcp_upload).toMatchObject({ tool: 'media_upload_part', part_size: MEDIA_UPLOAD_PART_BYTES, part_count: 3 });
      const selected = { media_id, expected_sha256: checksum };
      const part = (index: number, source = video) => {
        const bytes = source.subarray(index * MEDIA_UPLOAD_PART_BYTES, (index + 1) * MEDIA_UPLOAD_PART_BYTES);
        return { ...selected, part_index: index, part_sha256: createHash('sha256').update(bytes).digest('hex'), data_base64: bytes.toString('base64') };
      };
      const finalPart = part(2), preview = await invoke('media_upload_part', finalPart);
      expect((await invoke('media_get', { media_id })).asset.upload.received_parts).toEqual([]);
      await expect(call(rt, 'media_upload_part', { ...finalPart, data_base64: 'YQ==', pending_operation_id: preview.pending_operation_id })).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
      await expect(call(second, 'media_upload_part', finalPart)).rejects.toThrow('selected project');
      await expect(call(readonly, 'media_upload_part', finalPart)).rejects.toThrow('tools:write');
      await invoke('media_upload_part', { ...finalPart, pending_operation_id: preview.pending_operation_id });
      await expect(call(rt, 'media_finalize_upload', selected)).rejects.toThrow('part 0');
      expect((await invoke('media_get', { media_id })).asset.upload).toMatchObject({ part_count: 3, received_parts: [{ part_index: 2, byte_length: 31 }] });
      await approve('media_upload_part', part(0));
      expect((await approve('media_upload_part', part(0))).result.details.already_present).toBe(true);
      const changed = Buffer.from(video); changed[20] = 98;
      await expect(call(rt, 'media_upload_part', part(0, changed))).rejects.toThrow('different bytes');
      await expect(call(rt, 'media_upload_part', { ...part(1), part_sha256: '0'.repeat(64) })).rejects.toThrow('Part SHA-256');
      await expect(call(rt, 'media_upload_part', { ...part(2), part_index: 3 })).rejects.toThrow('length and index');
      await approve('media_upload_part', part(1));
      const finalPreview = await invoke('media_finalize_upload', selected);
      expect((await invoke('media_get', { media_id })).asset.status).toBe('PROCESSING');
      const finished = await invoke('media_finalize_upload', { ...selected, pending_operation_id: finalPreview.pending_operation_id });
      expect(finished.result.details.asset).toMatchObject({ id: media_id, sha256: checksum, status: 'READY', byte_length: video.length });
      expect(Buffer.from((await owner.read(selected)).bytes).equals(video)).toBe(true);
      await expect(call(rt, 'media_upload_part', part(2))).rejects.toThrow('finalized or expired');
      const objects = await admin.storage.from('creative-media').list(projects[0]!, { search: `${media_id}.part-` });
      expect(objects.data).toEqual([]);
      const audits = await db()<Array<{ event: string }>>`select event from public.audit_events where organization_id = ${projects[0]!} and tool = 'media_upload_part'`;
      expect(audits.filter(row => row.event === 'applied')).toHaveLength(4);
    } finally { await host.close(); await server.close(); }
  });

  it('never marks parts ready when the whole checksum differs, rejects expired parts, and removes partial sources on guarded deletion', async () => {
    const rt = await runtime(), checksum = '0'.repeat(64);
    const metadata = { name: 'wrong-parts.png', content_type: 'image/png', byte_length: bytes.length, sha256: checksum };
    const reserved = await apply(rt, 'media_prepare_upload', metadata), media_id = reserved.result.details.media_id;
    const selected = { media_id, expected_sha256: checksum }, part = { ...selected, part_index: 0, part_sha256: sha256, data_base64: bytes.toString('base64') };
    await apply(rt, 'media_upload_part', part);
    await expect(call(rt, 'media_finalize_upload', selected)).rejects.toThrow('SHA-256');
    expect((await call(rt, 'media_get', { media_id })).asset.status).toBe('PROCESSING');
    await db()`update private.creative_media set expires_at = now() - interval '1 minute' where id = ${media_id}`;
    await expect(call(rt, 'media_upload_part', part)).rejects.toThrow('finalized or expired');
    await apply(rt, 'media_delete', { ...selected, expected_name: metadata.name });
    expect((await call(rt, 'media_get', { media_id })).asset.status).toBe('DELETED');
    expect((await admin.storage.from('creative-media').list(projects[0]!, { search: `${media_id}.part-` })).data).toEqual([]);
  });

  it('removes expired temporary parts before releasing an abandoned upload reservation', async () => {
    const rt = await runtime(), metadata = { name: 'abandoned-parts.png', content_type: 'image/png', byte_length: bytes.length, sha256 };
    const prepared = await apply(rt, 'media_prepare_upload', metadata), media_id = prepared.result.details.media_id;
    await apply(rt, 'media_upload_part', { media_id, expected_sha256: sha256, part_index: 0, part_sha256: sha256, data_base64: bytes.toString('base64') });
    await db()`update private.creative_media set created_at = now() - interval '4 hours', expires_at = now() - interval '3 hours' where id = ${media_id}`;
    await apply(rt, 'media_prepare_upload', { ...metadata, name: 'after-abandoned.png' });
    expect((await admin.storage.from('creative-media').list(projects[0]!, { search: `${media_id}.part-` })).data).toEqual([]);
    await expect(call(rt, 'media_get', { media_id })).rejects.toThrow('selected project');
  });

  it('shares versioned metadata, filtered chronological pages and private distribution receipts across agents and UI', async () => {
    const rt = await runtime(), input = { name: 'central-library-fixture.png', content_type: 'image/png', byte_length: bytes.length, sha256, data_base64: bytes.toString('base64') };
    const upload = await apply(rt, 'media_upload', input), media_id = upload.result.details.media_id;
    const source = await owner.get(media_id);
    expect(source).toMatchObject({ metadata_version: 1, tags: [], platforms: [], status: 'READY' });
    const metadata = { media_id, expected_sha256: sha256, expected_version: 1, tags: [' Launch ', 'launch'], platforms: ['meta', 'pinterest'] };
    const preview = await call(rt, 'media_update_metadata', metadata);
    expect((await owner.get(media_id)).tags).toEqual([]);
    await call(rt, 'media_update_metadata', { ...metadata, pending_operation_id: preview.pending_operation_id });
    expect(await owner.get(media_id)).toMatchObject({ tags: ['launch'], platforms: ['meta', 'pinterest'], metadata_version: 2, sha256 });
    await expect(call(rt, 'media_update_metadata', metadata)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });
    await expect(other.get(media_id)).rejects.toThrow('selected project');
    expect((await owner.list({ limit: 1, query: 'CENTRAL-LIBRARY', platform: 'pinterest', tag: 'LAUNCH', kind: 'image' })).assets.map(asset => asset.id)).toEqual([media_id]);
    expect((await owner.list({ limit: 1, query: 'central-library', platform: 'google' })).assets).toEqual([]);
    const second = await apply(rt, 'media_upload', { ...input, name: 'central-library-second.png' }), nextId = second.result.details.media_id;
    const page = await owner.list({ limit: 1, query: 'central-library' });
    expect(page.assets[0]!.id).toBe(nextId); expect(page.truncated).toBe(true);
    expect((await owner.list({ limit: 1, query: 'central-library', cursor: page.next_cursor })).assets[0]!.id).toBe(media_id);
    await expect(other.list({ limit: 10, cursor: media_id })).rejects.toThrow('selected project');
    const destination = { media_id, expected_sha256: sha256, provider: 'meta', account_id: 'qa-account', tool: 'meta_upload_image' };
    await owner.trackUpload(destination, async () => ({ applied: true, resourceIds: ['native-image'], details: { private_upload_url: 'https://provider.test/?secret=never-store' } }));
    await expect(owner.trackUpload(destination, async () => { throw new AdportError('PROVIDER_ERROR', 'Native timeout', { resource_ids: ['native-unconfirmed'] }); })).rejects.toMatchObject({ details: { distribution_id: expect.any(String) } });
    const history = await owner.distributions(media_id);
    expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'ACCEPTED', resource_ids: ['native-image'] }), expect.objectContaining({ status: 'UNCONFIRMED', resource_ids: ['native-unconfirmed'] })]));
    expect(JSON.stringify(history)).not.toContain('never-store');
    await expect(other.distributions(media_id)).rejects.toThrow('selected project');
    expect(Buffer.from((await owner.read({ media_id, expected_sha256: sha256 })).bytes).equals(bytes)).toBe(true);
    const anonymousRows = await anonymous.schema('private').from('creative_media_distributions').select('*'); expect(anonymousRows.error).not.toBeNull();
  });
});

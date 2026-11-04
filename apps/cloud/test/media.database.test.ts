import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { cleanupDeletedProjectMedia, ProjectMediaLibrary } from '@/lib/cloud/media';
import { resolveMembership } from '@/lib/cloud/repository';
import { PostgresAuditStore, PostgresPendingStore } from '@/lib/cloud/repository';
import { createContext, DEFAULT_POLICY, PolicyEngine } from '@adport/core';
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
      const rows = await db()<Array<{ objectPath: string }>>`select object_path from private.creative_media where organization_id in ${db()(projects)}`;
      if (rows.length) await admin.storage.from('creative-media').remove(rows.map(row => row.objectPath));
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

  it('stores and transfers a checksum-bound PDF without rendering it as audio', async () => {
    const rt = await runtime(), pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'), checksum = createHash('sha256').update(pdf).digest('hex');
    const input = { name: 'private-document.pdf', content_type: 'application/pdf', byte_length: pdf.length, sha256: checksum, data_base64: pdf.toString('base64') };
    const result = await apply(rt, 'media_upload', input), media_id = result.result.resourceIds[0];
    const found = await call(rt, 'media_get', { media_id });
    expect(found.asset).toMatchObject({ content_type: 'application/pdf', sha256: checksum, status: 'READY' });
    expect(Buffer.from(await (await fetch(found.asset.preview_url)).arrayBuffer())).toEqual(pdf);
    expect(Buffer.from((await owner.read({ media_id, expected_sha256: checksum }, { contentTypes: ['application/pdf'] })).bytes).equals(pdf)).toBe(true);
    const gallery = await call(rt, 'media_list', { limit: 100 });
    expect(gallery.creatives.find((v: any) => v.id === media_id).media).toEqual([]);
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
});

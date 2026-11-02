import { createHash, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { cleanupDeletedProjectMedia, ProjectMediaLibrary } from '@/lib/cloud/media';
import { resolveMembership } from '@/lib/cloud/repository';

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
    expect(found.assets.find(asset => asset.id === prepared.media_id)).toMatchObject({ sha256, width: 1200, height: 628, byte_length: bytes.byteLength });
    const read = await owner.read({ media_id: prepared.media_id, expected_sha256: sha256 });
    expect(Buffer.from(read.bytes).equals(bytes)).toBe(true);
    await expect(other.read({ media_id: prepared.media_id, expected_sha256: sha256 })).rejects.toThrow('selected project');
    expect((await other.list({ limit: 10 })).assets.some(asset => asset.id === prepared.media_id)).toBe(false);
    await expect(owner.read({ media_id: prepared.media_id, expected_sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256');
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
});

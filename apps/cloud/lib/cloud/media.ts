import 'server-only';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AdportError, verifyMedia, type MediaAsset, type MediaLibrary, type MediaSource, type VerifiedMedia } from '@adport/core';
import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireScope } from './auth';
import type { TenantPrincipal } from './types';

const BUCKET = 'creative-media';
// Compatible with the default Supabase global upload limit. Local provider
// uploads may accept larger files; each provider still enforces its own limit.
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const RESERVED_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg'] as const;
export const mediaUploadSchema = z.object({
  name: z.string().min(1).max(240), content_type: z.enum(MEDIA_TYPES), byte_length: z.number().int().positive().max(MAX_MEDIA_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
interface StoredMedia {
  id: string; organizationId: string; name: string; objectPath: string; contentType: string; byteLength: number | string;
  sha256: string; status: 'uploading' | 'ready' | 'failed'; width: number | null; height: number | null; expiresAt: Date;
}

export async function inspectMediaBytes(bytes: Uint8Array<ArrayBuffer>, metadata: z.infer<typeof mediaUploadSchema>): Promise<{ file: VerifiedMedia; width?: number; height?: number }> {
  if (bytes.byteLength !== metadata.byte_length) throw new HttpError('The uploaded file size differs from the approved file.', 400);
  const file = verifyMedia(bytes, metadata.name, metadata.sha256, { maxBytes: MAX_MEDIA_BYTES, contentTypes: MEDIA_TYPES });
  if (file.contentType !== metadata.content_type) throw new HttpError('The uploaded file contents do not match its media type.', 400);
  if (!file.contentType.startsWith('image/')) return { file };
  try {
    const image = sharp(Buffer.from(bytes), { animated: true, limitInputPixels: 40_000_000, failOn: 'warning' });
    const info = await image.metadata();
    if (!info.width || !info.height || info.width * info.height > 40_000_000 || (info.pages ?? 1) > 300) throw new Error('Image limits');
    // Fully decode before making a preview available, preserving the approved source bytes.
    await image.raw().toBuffer();
    return { file, width: info.width, height: info.pageHeight ?? info.height };
  } catch { throw new HttpError('The image could not be decoded or exceeds the image limits.', 400); }
}

/** The only provider upload resolver used in cloud: no paths or arbitrary URLs. */
export class ProjectMediaLibrary implements MediaLibrary {
  constructor(private readonly principal: TenantPrincipal) {}

  private async record(id: string): Promise<StoredMedia> {
    if (!z.string().uuid().safeParse(id).success) throw new AdportError('INVALID_INPUT', 'Choose a valid project media_id.');
    const rows = await db()<StoredMedia[]>`select * from private.creative_media where id = ${id} and organization_id = ${this.principal.organizationId}`;
    if (!rows[0]) throw new AdportError('INVALID_INPUT', 'Media not found in the selected project.');
    return rows[0];
  }

  async read(source: MediaSource, options: { maxBytes?: number; contentTypes?: readonly string[] } = {}): Promise<VerifiedMedia> {
    if (source.file_path || !source.media_id) throw new AdportError('INVALID_INPUT', 'Hosted uploads require a project media_id; server file paths are not accepted.');
    const row = await this.record(source.media_id);
    if (row.status !== 'ready') throw new AdportError('INVALID_INPUT', 'Finish and verify the media upload before using it.');
    if (row.sha256 !== source.expected_sha256.toLowerCase()) throw new AdportError('INVALID_INPUT', 'Media SHA-256 mismatch. Select the approved project asset.');
    if (Number(row.byteLength) > (options.maxBytes ?? MAX_MEDIA_BYTES)) throw new AdportError('INVALID_INPUT', 'Media exceeds this provider upload size limit.');
    const { data, error } = await createAdminClient().storage.from(BUCKET).download(row.objectPath);
    if (error || !data) throw new HttpError('The media file could not be read. Try again.', 502);
    if (data.size !== Number(row.byteLength)) throw new AdportError('INVALID_INPUT', 'Stored media size changed. Upload the file again.');
    return verifyMedia(new Uint8Array(await data.arrayBuffer()), row.name, source.expected_sha256, options);
  }

  /** Called only inside an approved provider mutation; never returned by a read tool. */
  async providerUrl(source: MediaSource, options: { maxBytes?: number; contentTypes?: readonly string[] } = {}) {
    requireScope(this.principal, 'tools:write');
    const file = await this.read(source, options);
    const row = await this.record(source.media_id!);
    const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUrl(row.objectPath, 3600);
    if (error || !data) throw new HttpError('The provider media source could not be prepared.', 502);
    return { url: data.signedUrl, expires_at: new Date(Date.now() + 3_600_000).toISOString(), sha256: file.sha256 };
  }

  async list(input: { limit: number; cursor?: string }) {
    const rows = input.cursor
      ? await db()<StoredMedia[]>`select * from private.creative_media where organization_id = ${this.principal.organizationId} and status = 'ready' and id < ${input.cursor} order by id desc limit ${input.limit + 1}`
      : await db()<StoredMedia[]>`select * from private.creative_media where organization_id = ${this.principal.organizationId} and status = 'ready' order by id desc limit ${input.limit + 1}`;
    const assets: MediaAsset[] = await Promise.all(rows.slice(0, input.limit).map(async row => {
      const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUrl(row.objectPath, 900);
      if (error || !data) throw new HttpError('Media previews could not be prepared.', 502);
      return { id: row.id, name: row.name, content_type: row.contentType, byte_length: Number(row.byteLength), sha256: row.sha256, status: 'READY',
        ...(row.width ? { width: row.width } : {}), ...(row.height ? { height: row.height } : {}), preview_url: data.signedUrl };
    }));
    const truncated = rows.length > input.limit;
    return { assets, truncated, ...(truncated ? { next_cursor: assets.at(-1)!.id } : {}),
      upload_page_url: `${env().ADPORT_CLOUD_BASE_URL}/dashboard/assets?project_id=${encodeURIComponent(this.principal.organizationId)}` };
  }

  /** Staging does not publish or mutate any advertising account. */
  async beginUpload(input: z.infer<typeof mediaUploadSchema>) {
    requireScope(this.principal, 'tools:write');
    // Signed upload URLs last two hours. Wait longer before removing abandoned
    // objects so an old grant cannot recreate a deleted orphan afterward.
    const stale = await db()<Array<{ id: string; objectPath: string }>>`select id, object_path from private.creative_media
      where organization_id = ${this.principal.organizationId} and status != 'ready' and created_at < now() - interval '3 hours' limit 100`;
    if (stale.length) {
      const { error } = await createAdminClient().storage.from(BUCKET).remove(stale.map(row => row.objectPath));
      if (error) throw new HttpError('Abandoned uploads could not be cleared. Try again later.', 502);
      await db()`delete from private.creative_media where organization_id = ${this.principal.organizationId} and id in ${db()(stale.map(row => row.id))} and status != 'ready'`;
    }
    const id = randomUUID(), objectPath = `${this.principal.organizationId}/${id}`;
    const name = input.name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
    await db().begin(async sql => {
      await sql`select id from public.organizations where id = ${this.principal.organizationId} for update`;
      // Storage signed grants cannot bind an expected size. Reserve the bucket
      // maximum until finalization to cap actual bytes, including failed uploads.
      const [usage] = await sql<Array<{ bytes: string; count: string }>>`select coalesce(sum(case when status = 'ready' then byte_length else 104857600 end), 0)::text as bytes, count(*)::text as count from private.creative_media where organization_id = ${this.principal.organizationId}`;
      if (Number(usage?.bytes) + RESERVED_UPLOAD_BYTES > 10 * 1024 ** 3 || Number(usage?.count) >= 1000) throw new HttpError('This project media library is full. Contact support to increase its capacity.', 409);
      await sql`insert into private.creative_media (id, organization_id, created_by, name, object_path, content_type, byte_length, sha256)
        values (${id}, ${this.principal.organizationId}, ${this.principal.userId ?? null}, ${name}, ${objectPath}, ${input.content_type}, ${input.byte_length}, ${input.sha256})`;
    });
    const { data, error } = await createAdminClient().storage.from(BUCKET).createSignedUploadUrl(objectPath, { upsert: false });
    if (error || !data) {
      await db()`update private.creative_media set status = 'failed' where id = ${id} and organization_id = ${this.principal.organizationId}`;
      throw new HttpError('The media upload could not be prepared.', 502);
    }
    return { media_id: id, upload_url: data.signedUrl, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  async finalize(id: string) {
    requireScope(this.principal, 'tools:write');
    const row = await this.record(id);
    if (row.status === 'ready') return { media_id: row.id, sha256: row.sha256, status: 'ready' as const };
    if (row.status !== 'uploading' || row.expiresAt.getTime() <= Date.now()) throw new HttpError('The upload expired. Start a new upload.', 409);
    const { data, error } = await createAdminClient().storage.from(BUCKET).download(row.objectPath);
    if (error || !data) throw new HttpError('Upload the file before finalizing it.', 409);
    const result = await inspectMediaBytes(new Uint8Array(await data.arrayBuffer()), { name: row.name, content_type: row.contentType as typeof MEDIA_TYPES[number], byte_length: Number(row.byteLength), sha256: row.sha256 });
    await db().begin(async sql => {
      const updated = await sql`update private.creative_media set status = 'ready', width = ${result.width ?? null}, height = ${result.height ?? null}, finalized_at = now()
        where id = ${id} and organization_id = ${this.principal.organizationId} and status = 'uploading' and expires_at > now() returning id`;
      if (!updated.length) throw new HttpError('The upload expired or was already finalized. Reload the library.', 409);
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${this.principal.organizationId}, ${this.principal.userId ?? null}, 'note', 'cloud', 'media_stage', '*', ${`Staged private media ${row.id} sha256=${row.sha256}`})`;
    });
    return { media_id: row.id, sha256: row.sha256, status: 'ready' as const };
  }
}

export async function cleanupDeletedProjectMedia(): Promise<{ checked: number; cleaned: number; failed: number }> {
  const jobs = await db()<Array<{ projectId: string }>>`select project_id from private.creative_media_cleanup where not_before <= now() order by not_before limit 5`;
  let cleaned = 0, failed = 0;
  for (const job of jobs) {
    try {
      const existing = await db()`select id from public.organizations where id = ${job.projectId}`;
      if (existing.length) throw new Error('Cleanup target is still an active project.');
      const storage = createAdminClient().storage.from(BUCKET);
      let empty = false;
      for (let page = 0; page < 3; page++) {
        const { data, error } = await storage.list(job.projectId, { limit: 1000, offset: 0 });
        if (error || !data) throw new Error('Storage listing failed.');
        if (!data.length) { empty = true; break; }
        if (data.some(file => !z.string().uuid().safeParse(file.name).success)) throw new Error('Unexpected media object path.');
        const removed = await storage.remove(data.map(file => `${job.projectId}/${file.name}`));
        if (removed.error) throw new Error('Storage deletion failed.');
      }
      if (!empty) throw new Error('More objects remain for the next cleanup run.');
      await db()`delete from private.creative_media_cleanup where project_id = ${job.projectId}`;
      cleaned++;
    } catch { failed++; console.error('Private media cleanup failed; the queued job will be retried.'); }
  }
  return { checked: jobs.length, cleaned, failed };
}

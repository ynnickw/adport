import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AdportError, verifyMedia, mediaUploadMetadataSchema, mediaWriteSchemas, mediaListSchema, MAX_PROJECT_MEDIA_BYTES, MEDIA_UPLOAD_PART_BYTES, PROJECT_MEDIA_TYPES, type HostFile, type MediaAsset, type MediaListInput, type ManagedMediaLibrary, type MediaSource, type VerifiedMedia, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { HttpError } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireScope } from './auth';
import { enforceRateLimit } from './repository';
import type { TenantPrincipal } from './types';
import { readHostFile } from './host-file';
import { mediaCoverUrl } from './media-cover';

const BUCKET = 'creative-media';
// Compatible with the default Supabase global upload limit. Local provider
// uploads may accept larger files; each provider still enforces its own limit.
export const MAX_MEDIA_BYTES = MAX_PROJECT_MEDIA_BYTES;
const RESERVED_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MEDIA_TYPES = PROJECT_MEDIA_TYPES;
export const mediaUploadSchema = mediaUploadMetadataSchema;
interface StoredMedia {
  id: string; organizationId: string; name: string; objectPath: string; contentType: string; byteLength: number | string;
  sha256: string; status: 'uploading' | 'ready' | 'failed'; width: number | null; height: number | null; expiresAt: Date; deletedAt: Date | null;
  tags: string[]; platforms: MediaAsset['platforms']; metadataVersion: number; createdAt: Date;
}
const partCount = (row: Pick<StoredMedia, 'byteLength'>) => Math.ceil(Number(row.byteLength) / MEDIA_UPLOAD_PART_BYTES);
const partPath = (row: Pick<StoredMedia, 'objectPath'>, index: number) => `${row.objectPath}.part-${index}`;
const partPaths = (row: Pick<StoredMedia, 'objectPath' | 'byteLength'>) => Array.from({ length: partCount(row) }, (_, index) => partPath(row, index));
const missingObject = (error: unknown) => !!error && typeof error === 'object' && ('statusCode' in error && String(error.statusCode) === '404' || 'code' in error && error.code === 'NoSuchKey');

async function removeObjects(paths: string[]) {
  for (let index = 0; index < paths.length; index += 1000) {
    const { error } = await createAdminClient().storage.from(BUCKET).remove(paths.slice(index, index + 1000));
    if (error) throw new HttpError('Private media byte cleanup was not confirmed. Reconcile this upload before retrying.', 502);
  }
}

export async function inspectMediaBytes(bytes: Uint8Array<ArrayBuffer>, metadata: z.infer<typeof mediaUploadSchema>): Promise<{ file: VerifiedMedia; width?: number; height?: number }> {
  if (bytes.byteLength !== metadata.byte_length) throw new HttpError('The uploaded file size differs from the approved file.', 400);
  const file = verifyMedia(bytes, metadata.name, metadata.sha256, { maxBytes: MAX_MEDIA_BYTES, contentTypes: MEDIA_TYPES, contentType: metadata.content_type });
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
export class ProjectMediaLibrary implements ManagedMediaLibrary {
  constructor(private readonly principal: TenantPrincipal) {}

  get scopeId() { return this.principal.organizationId; }

  private async record(id: string, includeDeleted = false): Promise<StoredMedia> {
    if (!z.string().uuid().safeParse(id).success) throw new AdportError('INVALID_INPUT', 'Choose a valid project media_id.');
    const rows = await db()<StoredMedia[]>`select * from private.creative_media where id = ${id} and organization_id = ${this.principal.organizationId}`;
    if (!rows[0]) throw new AdportError('INVALID_INPUT', 'Media not found in the selected project.');
    if (rows[0].deletedAt && !includeDeleted) throw new AdportError('INVALID_INPUT', 'This project media has been deleted.');
    return rows[0];
  }

  private async asset(row: StoredMedia, includeDownload = true): Promise<MediaAsset> {
    let preview: string | undefined;
    let upload: MediaAsset['upload'];
    if (includeDownload && row.status === 'ready' && !row.deletedAt) {
      const storage = createAdminClient().storage.from(BUCKET);
      const { data, error } = await (row.contentType === 'text/csv' ? storage.createSignedUrl(row.objectPath, 900, { download: true }) : storage.createSignedUrl(row.objectPath, 900));
      if (error || !data) throw new HttpError('Media previews could not be prepared.', 502);
      preview = data.signedUrl;
    }
    if (includeDownload && row.status !== 'ready' && !row.deletedAt) {
      const storage = createAdminClient().storage.from(BUCKET);
      const [parts, whole] = await Promise.allSettled([
        storage.list(this.scopeId, { search: `${row.id}.part-`, limit: 100 }),
        storage.info(row.objectPath),
      ]);
      const files = parts.status === 'fulfilled' && !parts.value.error && Array.isArray(parts.value.data) ? parts.value.data : undefined;
      const received_parts = (files ?? []).flatMap(file => {
        const index = partPaths(row).indexOf(`${this.scopeId}/${file.name}`), size: unknown = file.metadata?.size;
        return index >= 0 && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? [{ part_index: index, byte_length: size }] : [];
      }).sort((a, b) => a.part_index - b.part_index);
      let whole_file: NonNullable<MediaAsset['upload']>['whole_file'] = { status: 'UNAVAILABLE' };
      if (whole.status === 'fulfilled') {
        const { data, error } = whole.value;
        if (error && missingObject(error)) whole_file = { status: 'NOT_FOUND' };
        else if (!error && data?.name === row.objectPath && data.bucketId === BUCKET) {
          const size: unknown = data.size;
          if (size === undefined) whole_file = { status: 'PRESENT_UNVERIFIED' };
          else if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) whole_file = { status: 'PRESENT_UNVERIFIED', byte_length: size, size_matches_reservation: size === Number(row.byteLength) };
        }
      }
      upload = { part_size: MEDIA_UPLOAD_PART_BYTES, part_count: partCount(row), received_parts, parts_state: files ? 'CHECKED' : 'UNAVAILABLE', expires_at: row.expiresAt.toISOString(), expired: row.expiresAt.getTime() <= Date.now(), checked_at: new Date().toISOString(), whole_file };
    }
    return { id: row.id, name: row.name, content_type: row.contentType, byte_length: Number(row.byteLength), sha256: row.sha256,
      status: row.deletedAt ? 'DELETED' : row.status === 'ready' ? 'READY' : row.status === 'uploading' ? 'PROCESSING' : 'FAILED',
      tags: row.tags ?? [], platforms: row.platforms ?? [], metadata_version: row.metadataVersion ?? 1, ...(row.createdAt ? { created_at: row.createdAt.toISOString() } : {}),
      ...(row.width ? { width: row.width } : {}), ...(row.height ? { height: row.height } : {}), ...(preview ? { preview_url: preview,
        ...(row.contentType === 'application/pdf' ? { preview_cover_url: mediaCoverUrl(preview, env().ADPORT_CLOUD_BASE_URL, env().NEXT_PUBLIC_SUPABASE_URL) } : {}),
      } : {}), ...(upload ? { upload } : {}) };
  }

  async get(id: string) {
    requireScope(this.principal, 'tools:read');
    return this.asset(await this.record(id, true));
  }

  async inspectFile(source: HostFile) {
    requireScope(this.principal, 'tools:read');
    const file = await readHostFile(source);
    const metadata = mediaUploadSchema.parse({ name: file.name, content_type: file.contentType, byte_length: file.bytes.length, sha256: file.sha256 });
    const { width, height } = await inspectMediaBytes(file.bytes, metadata);
    return { file_id: source.file_id, metadata, ...(width ? { width } : {}), ...(height ? { height } : {}) };
  }

  async distributions(id: string) {
    requireScope(this.principal, 'tools:read');
    await this.record(id, true);
    const rows = await db()<Array<{ id: string; provider: string; accountId: string; tool: string; status: string; resourceIds: string[]; errorCode: string | null; createdAt: Date; updatedAt: Date }>>`
      select id, provider, account_id, tool, status, resource_ids, error_code, created_at, updated_at
      from private.creative_media_distributions where organization_id = ${this.scopeId} and media_id = ${id} order by created_at desc, id desc limit 50`;
    return rows.map(row => ({ id: row.id, provider: row.provider, account_id: row.accountId, tool: row.tool, status: row.status, resource_ids: row.resourceIds, error_code: row.errorCode, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() }));
  }

  /** Runs inside the normal provider apply, after its approval was consumed. */
  async trackUpload(input: { media_id: string; expected_sha256: string; provider: string; account_id: string; tool: string }, execute: () => Promise<WriteResult>): Promise<WriteResult> {
    requireScope(this.principal, 'tools:write');
    const source = await this.record(input.media_id);
    if (source.status !== 'ready' || source.sha256 !== input.expected_sha256.toLowerCase()) throw new AdportError('INVALID_INPUT', 'Distribution source is no longer ready or its checksum changed.');
    const id = randomUUID();
    await db()`insert into private.creative_media_distributions (id, organization_id, media_id, source_sha256, provider, account_id, tool, status)
      values (${id}, ${this.scopeId}, ${source.id}, ${source.sha256}, ${input.provider}, ${input.account_id}, ${input.tool}, 'STARTED')`;
    const safeIds = (values: unknown) => Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string' && value.length <= 512 && !/[\s\x00-\x1f]/.test(value) && !/^https?:/i.test(value)).slice(0, 100) : [];
    let result: WriteResult;
    try { result = await execute(); if (result.applied !== true) throw new AdportError('PROVIDER_ERROR', 'The provider did not confirm the upload. Reconcile before trying again.', { resource_ids: result.resourceIds }); }
    catch (error) {
      const details = error instanceof AdportError && error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
      const code = error instanceof AdportError ? error.code : 'PROVIDER_ERROR';
      try { await db()`update private.creative_media_distributions set status = 'UNCONFIRMED', resource_ids = ${safeIds(details.resource_ids)}, error_code = ${code}, updated_at = now() where id = ${id} and organization_id = ${this.scopeId}`; } catch { /* STARTED remains a reconciliation marker. */ }
      throw new AdportError(code, error instanceof Error ? error.message : 'Provider upload was not confirmed. Reconcile before retrying.', { ...details, distribution_id: id });
    }
    try { await db()`update private.creative_media_distributions set status = 'ACCEPTED', resource_ids = ${safeIds(result.resourceIds)}, updated_at = now() where id = ${id} and organization_id = ${this.scopeId}`; }
    catch { throw new AdportError('PROVIDER_ERROR', 'The provider upload completed, but its library receipt could not be saved. Do not upload again; reconcile the returned native IDs.', { resource_ids: result.resourceIds, distribution_id: id, execution_state: 'APPLIED_TRACKING_UNCONFIRMED' }); }
    return { ...result, details: { ...(result.details && typeof result.details === 'object' ? result.details : {}), distribution_id: id } };
  }

  async read(source: MediaSource, options: { maxBytes?: number; contentTypes?: readonly string[] } = {}): Promise<VerifiedMedia> {
    if (source.file_path || !source.media_id) throw new AdportError('INVALID_INPUT', 'Hosted uploads require a project media_id; server file paths are not accepted. Stage a ChatGPT attachment with media_inspect_file → media_import_file; otherwise use media_upload, or media_prepare_upload → HTTP PUT or media_upload_part → media_finalize_upload. Then pass the returned media_id and SHA-256. No dashboard is required.');
    const row = await this.record(source.media_id);
    if (row.status !== 'ready') throw new AdportError('INVALID_INPUT', 'Finish and verify the media upload before using it.');
    if (row.sha256 !== source.expected_sha256.toLowerCase()) throw new AdportError('INVALID_INPUT', 'Media SHA-256 mismatch. Select the approved project asset.');
    if (Number(row.byteLength) > (options.maxBytes ?? MAX_MEDIA_BYTES)) throw new AdportError('INVALID_INPUT', 'Media exceeds this provider upload size limit.');
    const { data, error } = await createAdminClient().storage.from(BUCKET).download(row.objectPath);
    if (error || !data) throw new HttpError('The media file could not be read. Try again.', 502);
    if (data.size !== Number(row.byteLength)) throw new AdportError('INVALID_INPUT', 'Stored media size changed. Upload the file again.');
    return verifyMedia(new Uint8Array(await data.arrayBuffer()), row.name, source.expected_sha256, { ...options, contentType: row.contentType });
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

  async list(raw: MediaListInput) {
    requireScope(this.principal, 'tools:read');
    const input = mediaListSchema.parse(raw), cursor = input.cursor ? await this.record(input.cursor, true) : undefined;
    const status = { READY: 'ready', PROCESSING: 'uploading', FAILED: 'failed' }[input.status ?? 'READY'];
    const rows = await db()<StoredMedia[]>`select * from private.creative_media where organization_id = ${this.scopeId} and status = ${status} and deleted_at is null
      and (${!input.query} or position(lower(${input.query ?? ''}) in lower(name)) > 0)
      and (${!input.kind} or split_part(content_type, '/', 1) = ${input.kind ?? ''} or (${input.kind === 'document'} and content_type in ('application/pdf', 'text/csv')))
      and (${!input.platform} or ${input.platform ?? ''} = any(platforms))
      and (${!input.tag} or ${input.tag ?? ''} = any(tags))
      and (${!cursor} or (created_at, id) < (${cursor?.createdAt ?? new Date(0)}, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
      order by created_at desc, id desc limit ${input.limit + 1}`;
    const assets = await Promise.all(rows.slice(0, input.limit).map(row => this.asset(row, row.status === 'ready')));
    const truncated = rows.length > input.limit;
    return { assets, truncated, ...(truncated ? { next_cursor: assets.at(-1)!.id } : {}),
      upload_config: { project_id: this.scopeId, storage_origin: new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin, max_bytes: MAX_MEDIA_BYTES, content_types: [...MEDIA_TYPES] },
      upload_page_url: `${env().ADPORT_CLOUD_BASE_URL}/dashboard/assets?project_id=${encodeURIComponent(this.principal.organizationId)}` };
  }

  /** Staging does not publish or mutate any advertising account. */
  async beginUpload(input: z.infer<typeof mediaUploadSchema>) {
    requireScope(this.principal, 'tools:write');
    // Signed upload URLs last two hours. Wait longer before removing abandoned
    // objects so an old grant cannot recreate a deleted orphan afterward.
    const stale = await db()<Array<{ id: string; objectPath: string; byteLength: number }>>`select id, object_path, byte_length from private.creative_media
      where organization_id = ${this.principal.organizationId} and status != 'ready' and created_at < now() - interval '3 hours' limit 100`;
    if (stale.length) {
      await removeObjects(stale.flatMap(row => [row.objectPath, ...partPaths(row)]));
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
    return { media_id: id, upload_url: data.signedUrl, method: 'PUT' as const, headers: { 'content-type': input.content_type, 'x-upsert': 'false' }, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), mcp_upload: { tool: 'media_upload_part', part_size: MEDIA_UPLOAD_PART_BYTES, part_count: partCount({ byteLength: input.byte_length }), next_tool: 'media_finalize_upload' } };
  }

  private async inspectUpload(row: StoredMedia) {
    if (row.status !== 'uploading' || row.expiresAt.getTime() <= Date.now()) throw new HttpError('The upload expired. Start a new upload.', 409);
    const storage = createAdminClient().storage.from(BUCKET), { data, error } = await storage.download(row.objectPath);
    if (error && !missingObject(error)) throw new HttpError('The uploaded file could not be read.', 502);
    let bytes: Uint8Array<ArrayBuffer>, assembled = false;
    if (data) {
      if (data.size !== Number(row.byteLength) || data.size > MAX_MEDIA_BYTES) throw new HttpError('The uploaded file size differs from the approved file.', 400);
      bytes = new Uint8Array(await data.arrayBuffer());
    } else {
      const chunks: Buffer[] = [];
      for (let index = 0; index < partCount(row); index++) {
        const part = await storage.download(partPath(row, index));
        if (part.error || !part.data) throw new HttpError(`Upload part ${index} before finalizing. Inspect media_get for received parts.`, missingObject(part.error) ? 409 : 502);
        const expected = Math.min(MEDIA_UPLOAD_PART_BYTES, Number(row.byteLength) - index * MEDIA_UPLOAD_PART_BYTES);
        if (part.data.size !== expected) throw new HttpError(`Upload part ${index} has an unexpected length.`, 400);
        chunks.push(Buffer.from(await part.data.arrayBuffer()));
      }
      bytes = Buffer.concat(chunks); assembled = true;
    }
    return { ...await inspectMediaBytes(bytes, { name: row.name, content_type: row.contentType as typeof MEDIA_TYPES[number], byte_length: Number(row.byteLength), sha256: row.sha256 }), assembled };
  }

  async finalize(id: string) {
    requireScope(this.principal, 'tools:write');
    const row = await this.record(id);
    if (row.status === 'ready') return { media_id: row.id, sha256: row.sha256, status: 'ready' as const };
    await db().begin(async sql => {
      const [locked] = await sql<StoredMedia[]>`select * from private.creative_media where id = ${id} and organization_id = ${this.scopeId} for update`;
      if (!locked || locked.deletedAt) throw new HttpError('The upload is no longer available.', 409);
      if (locked.status === 'ready') return;
      const result = await this.inspectUpload(locked);
      if (result.assembled) {
        const uploaded = await createAdminClient().storage.from(BUCKET).upload(locked.objectPath, result.file.bytes, { contentType: locked.contentType, upsert: false });
        if (uploaded.error) throw new HttpError('Assembly storage was not confirmed. Inspect media_get and prepare a fresh finalization preview; do not repeat any part writes.', 502);
      }
      // Keep the 100 MiB reservation until both source and temporary parts are reconciled.
      await removeObjects(partPaths(locked));
      const updated = await sql`update private.creative_media set status = 'ready', width = ${result.width ?? null}, height = ${result.height ?? null}, finalized_at = now()
        where id = ${id} and organization_id = ${this.principal.organizationId} and status = 'uploading' and deleted_at is null and expires_at > now() returning id`;
      if (!updated.length) throw new HttpError('The upload expired or was already finalized. Reload the library.', 409);
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${this.principal.organizationId}, ${this.principal.userId ?? null}, 'note', 'cloud', 'media_stage', '*', ${`Staged private media ${row.id} sha256=${row.sha256}`})`;
    });
    return { media_id: row.id, sha256: row.sha256, status: 'ready' as const };
  }

  private async plan(op: WriteOperation): Promise<WritePreview & { execute(): Promise<WriteResult> }> {
    requireScope(this.principal, 'tools:write');
    const tool = op.tool as keyof typeof mediaWriteSchemas, schema = mediaWriteSchemas[tool];
    const kind = tool === 'media_delete' ? 'remove' : tool === 'media_rename' || tool === 'media_update_metadata' || tool === 'media_finalize_upload' || tool === 'media_upload_part' ? 'update' : 'create';
    if (!Object.hasOwn(mediaWriteSchemas, tool) || !schema || op.provider !== 'media' || op.accountId !== this.scopeId || op.kind !== kind) throw new AdportError('INVALID_INPUT', 'Invalid project media operation.');
    const input = schema.parse(op.payload);
    const base = { coercions: [], budgetDeltas: [], serverValidated: false };
    if (tool === 'media_prepare_upload' || tool === 'media_upload' || tool === 'media_import_file') {
      const metadata = mediaUploadSchema.parse(input);
      let bytes: Buffer<ArrayBuffer> | undefined;
      if (tool === 'media_upload') {
        const inline = mediaWriteSchemas.media_upload.parse(input);
        bytes = Buffer.from(inline.data_base64, 'base64');
        if (bytes.toString('base64') !== inline.data_base64) throw new AdportError('INVALID_INPUT', 'Use canonical padded base64 for the exact media bytes.');
        await inspectMediaBytes(bytes, metadata);
      }
      if (tool === 'media_import_file') {
        const source = mediaWriteSchemas.media_import_file.parse(input);
        bytes = Buffer.from((await readHostFile(source.file)).bytes);
        await inspectMediaBytes(bytes, metadata);
      }
      const notes = [bytes ? 'File bytes, type, size and SHA-256 verified.' : 'File bytes will be verified after transfer.', 'Private project storage. Uploading to an ad platform is a separate action.'];
      return { ...base, summary: `${bytes ? 'Upload' : 'Prepare upload for'} project media “${metadata.name}”`, changes: [`+ ${metadata.name}; ${metadata.content_type}; ${metadata.byte_length} bytes; SHA-256 ${metadata.sha256}`], fieldChanges: [{ field: 'File', before: '(new)', after: metadata.name }, { field: 'Bytes', before: '0', after: String(metadata.byte_length) }, { field: 'SHA-256', before: '(new)', after: metadata.sha256 }], notes,
        review: { provider: 'media', accountId: this.scopeId, kind: 'create', title: bytes ? 'Upload file' : 'Prepare upload', subject: metadata.name, fields: [{ label: 'Type', after: metadata.content_type }, { label: 'Size', after: `${metadata.byte_length.toLocaleString('en-US')} bytes` }, { label: 'SHA-256', after: metadata.sha256 }], notices: notes }, execute: async () => {
        if (!await enforceRateLimit(`media:${this.principal.userId ?? this.principal.apiKeyId ?? this.principal.oauthTokenId}:${this.scopeId}`, 60)) throw new HttpError('Too many uploads. Try again in a minute.', 429);
        const grant = await this.beginUpload(metadata);
        if (!bytes) return { applied: true, resourceIds: [grant.media_id], details: grant };
        try {
          if (tool === 'media_import_file') {
            const { error } = await createAdminClient().storage.from(BUCKET).upload(`${this.scopeId}/${grant.media_id}`, bytes, { contentType: metadata.content_type, upsert: false });
            if (error) throw new Error('Storage import failed');
          } else {
            const uploaded = await fetch(grant.upload_url, { method: 'PUT', headers: grant.headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(60_000) });
            if (!uploaded.ok) throw new Error('Storage upload failed');
          }
          await this.finalize(grant.media_id);
          return { applied: true, resourceIds: [grant.media_id], details: { media_id: grant.media_id, sha256: metadata.sha256, status: 'ready', asset: await this.asset(await this.record(grant.media_id), false) } };
        } catch { throw new AdportError('PROVIDER_ERROR', 'Media upload was started but completion was not confirmed. Read media_get for this ID; reconcile before preparing another upload.', { media_id: grant.media_id }); }
      } };
    }
    const selected = mediaWriteSchemas.media_finalize_upload.parse(input), row = await this.record(selected.media_id);
    if (row.sha256 !== selected.expected_sha256) throw new AdportError('INVALID_INPUT', 'Media SHA-256 differs from the selected file.');
    if (tool === 'media_upload_part') {
      const value = mediaWriteSchemas.media_upload_part.parse(input), bytes = Buffer.from(value.data_base64, 'base64');
      if (row.status !== 'uploading' || row.expiresAt.getTime() <= Date.now()) throw new HttpError('This upload is finalized or expired. Inspect media_get.', 409);
      const expected = Math.min(MEDIA_UPLOAD_PART_BYTES, Number(row.byteLength) - value.part_index * MEDIA_UPLOAD_PART_BYTES);
      if (expected <= 0 || bytes.length !== expected || bytes.toString('base64') !== value.data_base64) throw new AdportError('INVALID_INPUT', 'Use canonical base64 for the exact reserved part length and index.');
      if (createHash('sha256').update(bytes).digest('hex') !== value.part_sha256) throw new AdportError('INVALID_INPUT', 'Part SHA-256 mismatch.');
      const path = partPath(row, value.part_index), storage = createAdminClient().storage.from(BUCKET);
      const checkExisting = async () => {
        const { data, error } = await storage.download(path);
        if (error && !missingObject(error)) throw new HttpError('Upload part could not be reconciled.', 502);
        if (!data) return false;
        if (data.size !== bytes.length || !Buffer.from(await data.arrayBuffer()).equals(bytes)) throw new AdportError('INVALID_INPUT', 'This immutable part already contains different bytes. Start a new upload.');
        return true;
      };
      const present = await checkExisting();
      return { ...base, summary: `Upload project media part ${value.part_index + 1}/${partCount(row)} for “${row.name}”`, changes: [`${present ? '=' : '+'} part ${value.part_index}; ${bytes.length} bytes; SHA-256 ${value.part_sha256}`], notes: ['Private temporary bytes only. No provider upload or publication. media_finalize_upload separately verifies the complete reserved checksum. Existing parts cannot be overwritten.'], execute: async () => db().begin(async sql => {
        const [locked] = await sql<StoredMedia[]>`select * from private.creative_media where id = ${row.id} and organization_id = ${this.scopeId} for update`;
        if (!locked || locked.deletedAt || locked.status !== 'uploading' || locked.expiresAt.getTime() <= Date.now()) throw new HttpError('This upload is finalized or expired. Inspect media_get.', 409);
        const existing = await checkExisting();
        if (!existing) {
          if (!await enforceRateLimit(`media-part:${this.scopeId}`, 120)) throw new HttpError('Too many upload parts. Try again later.', 429);
          const { error } = await storage.upload(path, bytes, { contentType: row.contentType, upsert: false });
          if (error) throw new AdportError('PROVIDER_ERROR', 'Part storage was not confirmed. Inspect media_get before requesting a new preview; do not replay this operation.', { media_id: row.id, part_index: value.part_index });
        }
        return { applied: true, resourceIds: [row.id], details: { media_id: row.id, part_index: value.part_index, byte_length: bytes.length, part_sha256: value.part_sha256, already_present: existing, next_tool: 'media_finalize_upload' } };
      }) };
    }
    if (tool === 'media_finalize_upload') {
      if (row.status !== 'ready') await this.inspectUpload(row);
      return { ...base, summary: `Verify project media “${row.name}”`, changes: [`~ ${row.id}: ${row.status} → ready; SHA-256 ${row.sha256}`], fieldChanges: [{ field: 'File readiness', before: row.status, after: 'ready' }], notes: ['The stored bytes are decoded and checksum-verified before provider uploads can use them.'], execute: async () => { await this.finalize(row.id); return { applied: true, resourceIds: [row.id], details: { media_id: row.id, sha256: row.sha256, status: 'ready', asset: await this.asset(await this.record(row.id), false) } }; } };
    }
    if (tool === 'media_update_metadata') {
      const value = mediaWriteSchemas.media_update_metadata.parse(input);
      if (row.status !== 'ready' || value.expected_version !== row.metadataVersion) throw new AdportError('PENDING_MISMATCH', 'Asset metadata changed. Read media_get and prepare a fresh preview.');
      const name = value.name?.replace(/[\\/\x00-\x1f\x7f]/g, '_') ?? row.name, tags = value.tags ?? row.tags, platforms = value.platforms ?? row.platforms ?? [];
      return { ...base, summary: `Organize project media “${row.name}”`, changes: [`Name: ${JSON.stringify(row.name)} → ${JSON.stringify(name)}`, `Tags: ${JSON.stringify(row.tags)} → ${JSON.stringify(tags)}`, `Platforms: ${JSON.stringify(row.platforms)} → ${JSON.stringify(platforms)}`], notes: ['Library metadata only. Platform labels do not distribute, publish or modify ads. Immutable source bytes and existing provider copies are preserved.'], execute: async () => {
        const updated = await db()`update private.creative_media set name = ${name}, tags = ${tags}, platforms = ${platforms}, metadata_version = metadata_version + 1
          where id = ${row.id} and organization_id = ${this.scopeId} and metadata_version = ${value.expected_version} and sha256 = ${row.sha256} and status = 'ready' and deleted_at is null returning id`;
        if (!updated.length) throw new AdportError('PENDING_MISMATCH', 'Asset metadata changed before apply. Read it and prepare a fresh preview.');
        return { applied: true, resourceIds: [row.id], details: { asset: await this.asset(await this.record(row.id), false) } };
      } };
    }
    const value = tool === 'media_rename' ? mediaWriteSchemas.media_rename.parse(input) : mediaWriteSchemas.media_delete.parse(input);
    if (value.expected_name !== row.name) throw new AdportError('INVALID_INPUT', 'Media name changed. Read the asset and request a fresh preview.');
    if (tool === 'media_rename') {
      const name = mediaWriteSchemas.media_rename.parse(input).name.replace(/[\\/\x00-\x1f\x7f]/g, '_');
      return { ...base, summary: `Rename project media “${row.name}”`, changes: [`~ name ${JSON.stringify(row.name)} → ${JSON.stringify(name)}`], fieldChanges: [{ field: 'File name', before: row.name, after: name }], notes: ['Immutable bytes and provider copies are preserved.'], execute: async () => {
        const updated = await db()`update private.creative_media set name = ${name}, metadata_version = metadata_version + 1 where id = ${row.id} and organization_id = ${this.scopeId} and name = ${row.name} and sha256 = ${row.sha256} and deleted_at is null returning id`;
        if (!updated.length) throw new AdportError('INVALID_INPUT', 'Media changed before the rename. Read it and preview again.');
        return { applied: true, resourceIds: [row.id], details: { asset: await this.asset(await this.record(row.id), false) } };
      } };
    }
    return { ...base, summary: `Delete project media “${row.name}”`, changes: [`- ${row.id}; ${row.name}; SHA-256 ${row.sha256}`], fieldChanges: [{ field: 'Project source', before: row.name, after: '(deleted)' }], notes: ['Permanently removes this project source. Provider copies, ads and campaigns are unchanged. A deletion record is retained until outstanding upload grants expire.'], execute: async () => {
      const updated = await db()`update private.creative_media set deleted_at = now(), status = 'failed' where id = ${row.id} and organization_id = ${this.scopeId} and name = ${row.name} and sha256 = ${row.sha256} and deleted_at is null returning id`;
      if (!updated.length) throw new AdportError('INVALID_INPUT', 'Media changed before deletion. Read it and preview again.');
      try { await removeObjects([row.objectPath, ...partPaths(row)]); }
      catch { throw new AdportError('PROVIDER_ERROR', 'Media reuse is blocked, but byte removal was not confirmed. Scheduled cleanup will retry; reconcile this ID.', { media_id: row.id }); }
      return { applied: true, resourceIds: [row.id], details: { media_id: row.id, status: 'deleted', storage_removed: true } };
    } };
  }

  async previewWrite(op: WriteOperation): Promise<WritePreview> {
    const { execute: _execute, ...preview } = await this.plan(op);
    return preview;
  }
  async applyWrite(op: WriteOperation): Promise<WriteResult> { return (await this.plan(op)).execute(); }
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
        if (data.some(file => !z.string().uuid().safeParse(file.name.replace(/\.part-(?:[0-9]|[1-4][0-9])$/, '')).success)) throw new Error('Unexpected media object path.');
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

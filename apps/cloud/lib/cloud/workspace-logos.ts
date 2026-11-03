import 'server-only';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { createAdminClient } from '@/lib/supabase/admin';
import { LOGO_ACCEPT, MAX_LOGO_BYTES, type WorkspaceLogoKind } from '@/lib/workspace-logos';

const BUCKET = 'workspace-logos';
interface LogoTarget {
  organizationId: string;
  auditProjectId: string;
  logoPath: string | null;
  role: string;
}

async function targetFor(userId: string, kind: WorkspaceLogoKind, id: string, sql: postgres.Sql | postgres.TransactionSql = db(), manage = false): Promise<LogoTarget> {
  const rows = kind === 'organization'
    ? await sql<LogoTarget[]>`select company.id as organization_id, company.default_project_id as audit_project_id, company.logo_path, member.role
        from public.organization_groups company
        join public.organization_group_memberships member on member.organization_group_id = company.id
        where company.id = ${id} and member.user_id = ${userId}`
    : await sql<LogoTarget[]>`select company.id as organization_id, project.id as audit_project_id, project.logo_path, member.role
        from public.organizations project
        join public.organization_groups company on company.id = project.organization_group_id
        join public.organization_group_memberships member on member.organization_group_id = company.id
        where project.id = ${id} and member.user_id = ${userId}
          and (member.role in ('owner', 'admin') or exists (
            select 1 from private.project_memberships access where access.organization_id = project.id and access.user_id = ${userId}))`;
  const target = rows[0];
  if (!target) throw new HttpError('Logo not found or access denied.', 404);
  if (manage && !['owner', 'admin'].includes(target.role)) throw new HttpError('Organization owner or admin access is required.', 403);
  return target;
}

export async function normalizeWorkspaceLogo(file: File): Promise<Buffer> {
  if (!file.size || file.size > MAX_LOGO_BYTES) throw new HttpError('Choose an image up to 2 MB.', 400);
  if (!LOGO_ACCEPT.split(',').includes(file.type)) throw new HttpError('Choose a PNG, JPG, or WebP image.', 400);
  try {
    const image = sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 16_777_216, failOn: 'warning' });
    const metadata = await image.metadata();
    const expectedFormat = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }[file.type];
    if (metadata.format !== expectedFormat || (metadata.pages ?? 1) !== 1) throw new Error('Unsupported image');
    // Decode and re-encode to strip metadata and preserve the complete logo, including transparency.
    return await image.autoOrient().resize(256, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw new HttpError('This image could not be read. Choose a valid PNG, JPG, or WebP image.', 400);
  }
}

export async function removeWorkspaceLogoObjects(paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    const { error } = await createAdminClient().storage.from(BUCKET).remove(paths);
    if (error) throw error;
  } catch {
    console.error('Workspace logo storage cleanup failed.');
  }
}

export async function updateWorkspaceLogo(userId: string, kind: WorkspaceLogoKind, id: string, file: File | null): Promise<string | null> {
  const initial = await targetFor(userId, kind, id, db(), true);
  let newPath: string | null = null;
  if (file) {
    const image = await normalizeWorkspaceLogo(file);
    newPath = `${kind}/${id}/${randomUUID()}.png`;
    const { error } = await createAdminClient().storage.from(BUCKET).upload(newPath, image, { contentType: 'image/png', upsert: false });
    if (error) throw new HttpError('The logo could not be uploaded. Please try again.', 502);
  }
  let previousPath: string | null = null;
  try {
    await db().begin(async sql => {
      await sql`select id from public.organization_groups where id = ${initial.organizationId} for update`;
      const target = await targetFor(userId, kind, id, sql, true);
      previousPath = target.logoPath;
      if (kind === 'organization') await sql`update public.organization_groups set logo_path = ${newPath} where id = ${id}`;
      else await sql`update public.organizations set logo_path = ${newPath} where id = ${id}`;
      await sql`insert into public.audit_events (organization_id, actor_user_id, event, provider, tool, account_id, summary)
        values (${target.auditProjectId}, ${userId}, 'settings_updated', 'cloud', ${`${kind}_logo_update`}, '*',
          ${`${file ? 'Updated' : 'Removed'} ${kind} logo`})`;
    });
  } catch (error) {
    if (newPath) await removeWorkspaceLogoObjects([newPath]);
    throw error;
  }
  if (previousPath) await removeWorkspaceLogoObjects([previousPath]);
  return newPath;
}

export async function readWorkspaceLogo(userId: string, kind: WorkspaceLogoKind, id: string): Promise<Blob> {
  const target = await targetFor(userId, kind, id);
  if (!target.logoPath) throw new HttpError('Logo not found.', 404);
  const { data, error } = await createAdminClient().storage.from(BUCKET).download(target.logoPath);
  if (error || !data) throw new HttpError('Logo not found.', 404);
  return data;
}

import { z } from 'zod';
import { env } from '@/lib/env';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { sessionPrincipal, requireScope } from '@/lib/cloud/auth';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { mediaUploadSchema, ProjectMediaLibrary } from '@/lib/cloud/media';

async function library(request: Request, write = false) {
  const projectId = new URL(request.url).searchParams.get('project_id');
  if (!z.string().uuid().safeParse(projectId).success) throw new HttpError('Choose a project.', 400);
  if (write && request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
  const principal = await sessionPrincipal(projectId!);
  requireScope(principal, write ? 'tools:write' : 'tools:read');
  if (write && !await enforceRateLimit(`media:${principal.userId}:${principal.organizationId}`, 12)) throw new HttpError('Too many uploads. Try again in a minute.', 429);
  return new ProjectMediaLibrary(principal);
}

async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > 4096) throw new HttpError('Upload metadata is too large.', 413);
  if (!request.body) throw new HttpError('Upload metadata is required.', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new HttpError('Upload metadata is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError('Invalid upload metadata.', 400); }
}

export async function GET(request: Request) {
  try { return noStoreJson(await (await library(request)).list({ limit: 100 })); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    const target = await library(request, true), parsed = mediaUploadSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError('Choose supported media up to 50 MB with a valid SHA-256.', 400);
    return noStoreJson(await target.beginUpload(parsed.data), 201);
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const target = await library(request, true), parsed = z.object({ media_id: z.string().uuid() }).safeParse(await body(request));
    if (!parsed.success) throw new HttpError('Choose a valid media_id.', 400);
    return noStoreJson(await target.finalize(parsed.data.media_id));
  } catch (error) { return apiError(error); }
}

import { z } from 'zod';
import { createContext, PolicyEngine, mediaListSchema } from '@adport/core';
import { env } from '@/lib/env';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { sessionPrincipal, requireScope } from '@/lib/cloud/auth';
import { enforceRateLimit, getOrganizationPolicy, PostgresPendingStore, PostgresAuditStore } from '@/lib/cloud/repository';
import { mediaUploadSchema, ProjectMediaLibrary } from '@/lib/cloud/media';

async function library(request: Request, write = false) {
  const projectId = new URL(request.url).searchParams.get('project_id');
  if (!z.string().uuid().safeParse(projectId).success) throw new HttpError('Choose a project.', 400);
  if (write && request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
  const principal = await sessionPrincipal(projectId!);
  requireScope(principal, write ? 'tools:write' : 'tools:read');
  if (write && !await enforceRateLimit(`media:${principal.userId}:${principal.organizationId}`, 120)) throw new HttpError('Too many uploads. Try again in a minute.', 429);
  return { target: new ProjectMediaLibrary(principal), principal };
}

async function privateWrite(selected: Awaited<ReturnType<typeof library>>, tool: string, args: Record<string, unknown>) {
  const runtime = await createContext({ media: selected.target, engine: new PolicyEngine(await getOrganizationPolicy(selected.principal.organizationId), new PostgresPendingStore(selected.principal), new PostgresAuditStore(selected.principal)) });
  const preview = await runtime.registry.call(tool, args, runtime.ctx) as { pending_operation_id: string };
  const applied = await runtime.registry.call(tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx) as { result: { details: unknown } };
  return applied.result.details;
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
  try {
    const params = new URL(request.url).searchParams;
    const input = mediaListSchema.parse({ limit: params.has('limit') ? Number(params.get('limit')) : 60, cursor: params.get('cursor') ?? undefined, query: params.get('query') ?? undefined, kind: params.get('kind') ?? undefined, platform: params.get('platform') ?? undefined, tag: params.get('tag') ?? undefined });
    return noStoreJson(await (await library(request)).target.list(input));
  }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    const selected = await library(request, true), parsed = mediaUploadSchema.safeParse(await body(request));
    if (!parsed.success) throw new HttpError('Choose supported media up to 50 MB with a valid SHA-256.', 400);
    return noStoreJson(await privateWrite(selected, 'media_prepare_upload', parsed.data), 201);
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const selected = await library(request, true), parsed = z.object({ media_id: z.string().uuid() }).safeParse(await body(request));
    if (!parsed.success) throw new HttpError('Choose a valid media_id.', 400);
    const asset = await selected.target.get(parsed.data.media_id);
    return noStoreJson(await privateWrite(selected, 'media_finalize_upload', { media_id: asset.id, expected_sha256: asset.sha256 }));
  } catch (error) { return apiError(error); }
}

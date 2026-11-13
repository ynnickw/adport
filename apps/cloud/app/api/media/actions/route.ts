import { AdportError } from '@adport/core';
import { z } from 'zod';
import { sessionPrincipal, requireScope } from '@/lib/cloud/auth';
import { createTenantRuntime } from '@/lib/cloud/runtime';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { env } from '@/lib/env';
import { apiError, HttpError, noStoreJson } from '@/lib/http';

const tools = new Set(['media_get', 'media_update_metadata', 'media_delete']);
const inputSchema = z.object({ tool: z.string().refine(value => tools.has(value)), arguments: z.record(z.string(), z.unknown()) }).strict();
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const projectId = new URL(request.url).searchParams.get('project_id');
    if (!z.string().uuid().safeParse(projectId).success) throw new HttpError('Choose a project.', 400);
    const principal = await sessionPrincipal(projectId!);
    if (!await enforceRateLimit(`media-action:${principal.userId}:${principal.organizationId}`, 120)) throw new HttpError('Too many library actions. Try again shortly.', 429);
    const reader = request.body?.getReader(); if (!reader) throw new HttpError('A library action is required.', 400);
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 32_768) { await reader.cancel(); throw new HttpError('Library action is too large.', 413); } chunks.push(next.value); }
    } finally { reader.releaseLock(); }
    const parsed = inputSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success) throw new HttpError('Choose a supported library action.', 400);
    const runtime = await createTenantRuntime(principal), definition = runtime.registry.get(parsed.data.tool);
    requireScope(principal, definition.annotations.readOnly ? 'tools:read' : 'tools:write');
    return noStoreJson(await runtime.registry.call(parsed.data.tool, parsed.data.arguments, runtime.ctx));
  } catch (error) {
    if (error instanceof AdportError && error.code === 'PROVIDER_ERROR') {
      const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
      return noStoreJson({ error: 'The file change was not confirmed. Reload this file before trying again.', code: error.code, ...(typeof details.media_id === 'string' ? { media_id: details.media_id } : {}) }, 502);
    }
    if (error instanceof SyntaxError) return apiError(new HttpError('Invalid library action.', 400));
    return apiError(error);
  }
}

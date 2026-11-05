import { z } from 'zod';
import { sessionPrincipal, requireScope } from '@/lib/cloud/auth';
import { createCatalogAccessRuntime } from '@/lib/cloud/catalog-access-runtime';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { env } from '@/lib/env';

const numericId = z.string().regex(/^\d{1,30}$/);
const base = z.object({ organizationId: z.string().uuid(), account_id: numericId }).strict();
const update = base.extend({ bc_id: numericId, catalog_id: numericId, mode: z.enum(['none', 'read', 'write']), expected_access_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), pending_operation_id: z.string().min(1).max(512).optional() }).strict();
async function owner(projectId: string) {
  const principal = await sessionPrincipal(projectId);
  if (principal.organizationId !== projectId) throw new HttpError('Project access could not be verified.', 403);
  if (!principal.userId || !['owner', 'admin'].includes(principal.role ?? '') || principal.clientId || principal.apiKeyId || principal.oauthTokenId) throw new HttpError('A signed-in project owner or admin is required.', 403);
  requireScope(principal, 'connections:manage');return principal;
}
export async function GET(request: Request) {
  try {
    const parsed = base.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new HttpError('Choose a valid project and advertiser.', 400);
    const input = parsed.data, principal = await owner(input.organizationId), runtime = await createCatalogAccessRuntime(principal, input.account_id);
    const result = await runtime.registry.call('tiktok_catalog_access', { account_id: input.account_id }, runtime.ctx) as Record<string, unknown>;
    return noStoreJson({ ...result, organizationId: principal.organizationId, account_id: input.account_id });
  } catch (error) { return apiError(error); }
}
async function boundedBody(request: Request) {
  if (!request.body) throw new HttpError('Catalog access metadata is missing.', 400);
  if (Number(request.headers.get('content-length')) > 4096) throw new HttpError('Catalog access metadata is too large.', 413);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];let size = 0;
  try {
    while (true) { const { done, value } = await reader.read();if (done) break;size += value.byteLength;if (size > 4096) { await reader.cancel();throw new HttpError('Catalog access metadata is too large.', 413); }chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return update.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new HttpError('Choose valid Business Center and catalog IDs.', 400); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const input = await boundedBody(request), principal = await owner(input.organizationId);
    if (!await enforceRateLimit(`catalog-access:${principal.organizationId}:${principal.userId}`, 60)) throw new HttpError('Too many access requests. Try again in a minute.', 429);
    const runtime = await createCatalogAccessRuntime(principal, input.account_id);
    const { organizationId: _project, pending_operation_id, ...args } = input;
    if (pending_operation_id && !input.expected_access_hash) throw new HttpError('Review the exact access change first.', 400);
    if (!args.expected_access_hash) {
      const snapshot = await runtime.registry.call('tiktok_catalog_access_snapshot', { account_id: args.account_id, bc_id: args.bc_id, catalog_id: args.catalog_id }, runtime.ctx) as { grant: { hash: string } };
      args.expected_access_hash = snapshot.grant.hash;
    }
    const result = await runtime.registry.call('tiktok_set_catalog_access', { ...args, ...(pending_operation_id ? { pending_operation_id } : {}) }, runtime.ctx);
    return noStoreJson({ result, arguments: { organizationId: input.organizationId, ...args } });
  } catch (error) { return apiError(error); }
}

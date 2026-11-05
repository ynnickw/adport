import { z } from 'zod';
import { sessionPrincipal, requireScope } from '@/lib/cloud/auth';
import { createCatalogAccessRuntime } from '@/lib/cloud/catalog-access-runtime';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { env } from '@/lib/env';

const numericId = z.string().regex(/^\d{1,30}$/), accountId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), businessId = z.string().regex(/^[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$/).transform(value => value.toLowerCase());
const base = z.object({ organizationId: z.string().uuid(), account_id: accountId, provider: z.enum(['tiktok', 'reddit']).optional() }).strict().refine(input => input.provider === 'reddit' || numericId.safeParse(input.account_id).success);
const update = z.object({ organizationId: z.string().uuid(), account_id: accountId, provider: z.enum(['tiktok', 'reddit']).optional(), bc_id: numericId.optional(), business_id: businessId.optional(), catalog_id: accountId.optional(), resource_kind: z.enum(['catalog', 'catalog_creation']).optional(), mode: z.enum(['none', 'read', 'write', 'create']), expected_access_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), pending_operation_id: z.string().min(1).max(512).optional() }).strict().refine(input => (input.provider === 'reddit' ? !!input.business_id && !input.bc_id : !!input.bc_id && !input.business_id && numericId.safeParse(input.account_id).success && (!input.catalog_id || numericId.safeParse(input.catalog_id).success)) && (input.resource_kind === 'catalog_creation' ? !input.catalog_id && ['none', 'create'].includes(input.mode) : !!input.catalog_id && input.mode !== 'create'), 'Choose an exact catalog grant or creation delegation in the selected platform');
const permissionRuntime = (principal: Awaited<ReturnType<typeof sessionPrincipal>>, account: string, provider?: 'tiktok' | 'reddit') => provider === 'reddit' ? createCatalogAccessRuntime(principal, account, 'reddit') : createCatalogAccessRuntime(principal, account);
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
    const input = parsed.data, principal = await owner(input.organizationId), runtime = await permissionRuntime(principal, input.account_id, input.provider);
    const result = await runtime.registry.call(input.provider === 'reddit' ? 'reddit_catalog_access' : 'tiktok_catalog_access', { account_id: input.account_id }, runtime.ctx) as Record<string, unknown>;
    return noStoreJson({ ...result, organizationId: principal.organizationId, account_id: input.account_id, ...(input.provider === 'reddit' ? { provider: 'reddit' } : {}) });
  } catch (error) { return apiError(error); }
}
async function boundedBody(request: Request) {
  if (!request.body) throw new HttpError('Catalog access metadata is missing.', 400);
  if (Number(request.headers.get('content-length')) > 4096) throw new HttpError('Catalog access metadata is too large.', 413);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];let size = 0;
  try {
    while (true) { const { done, value } = await reader.read();if (done) break;size += value.byteLength;if (size > 4096) { await reader.cancel();throw new HttpError('Catalog access metadata is too large.', 413); }chunks.push(value); }
  } finally { reader.releaseLock(); }
  try { return update.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { throw new HttpError('Choose valid business and catalog IDs or a creation delegation.', 400); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const input = await boundedBody(request), principal = await owner(input.organizationId);
    if (!await enforceRateLimit(`catalog-access:${principal.organizationId}:${principal.userId}`, 60)) throw new HttpError('Too many access requests. Try again in a minute.', 429);
    const runtime = await permissionRuntime(principal, input.account_id, input.provider);
    const { organizationId: _project, provider: _platform, pending_operation_id, ...args } = input;
    if (pending_operation_id && !input.expected_access_hash) throw new HttpError('Review the exact access change first.', 400);
    if (!args.expected_access_hash) {
      const snapshot = await runtime.registry.call(input.provider === 'reddit' ? 'reddit_catalog_access_snapshot' : 'tiktok_catalog_access_snapshot', { account_id: args.account_id, ...(args.business_id ? { business_id: args.business_id } : { bc_id: args.bc_id }), ...(args.catalog_id ? { catalog_id: args.catalog_id } : {}), ...(args.resource_kind ? { resource_kind: args.resource_kind } : {}) }, runtime.ctx) as { grant: { hash: string } };
      args.expected_access_hash = snapshot.grant.hash;
    }
    const result = await runtime.registry.call(input.provider === 'reddit' ? 'reddit_set_catalog_access' : 'tiktok_set_catalog_access', { ...args, ...(pending_operation_id ? { pending_operation_id } : {}) }, runtime.ctx);
    return noStoreJson({ result, arguments: { organizationId: input.organizationId, ...(input.provider === 'reddit' ? { provider: 'reddit' } : {}), ...args } });
  } catch (error) { return apiError(error); }
}

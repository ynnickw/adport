import { resolve } from 'node:path';
import { AdportError, LocalMediaResolver, MAX_PROJECT_MEDIA_BYTES, PROJECT_MEDIA_TYPES } from '@adport/core';
import { z } from 'zod';

export interface CloudOptions { cloudUrl: string; apiKeyEnv: string }
function cloud(options: CloudOptions) {
  const url = new URL(options.cloudUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AdportError('INVALID_INPUT', 'Use the HTTPS origin of your Adport Cloud server.');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.apiKeyEnv)) throw new AdportError('INVALID_INPUT', 'Use an environment variable name for the project API key.');
  const key = process.env[options.apiKeyEnv];
  if (!key?.startsWith('adp_')) throw new AdportError('INVALID_INPUT', 'Set the selected environment variable to a project-scoped Adport API key.');
  return { origin: url.origin, key };
}

export async function cloudTool(tool: string, input: unknown, options: CloudOptions, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(tool)) throw new AdportError('INVALID_INPUT', 'Invalid tool name.');
  const { origin, key } = cloud(options);
  const response = await fetchImpl(`${origin}/api/v1/tools/${tool}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(90_000) });
  let result: unknown;
  try { result = await response.json(); } catch { throw new AdportError('PROVIDER_ERROR', 'Cloud returned an invalid tool response.'); }
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    throw new AdportError('PROVIDER_ERROR', typeof error === 'string' ? error : 'Cloud tool request failed.');
  }
  return result;
}

const receipt = z.object({ status: z.enum(['applied', 'pending_validation']), applied: z.boolean().optional(), pending_operation_id: z.string().optional(), result: z.object({ resourceIds: z.array(z.string()).optional(), details: z.unknown().optional() }).optional() }).passthrough();
const uploadGrant = z.object({ media_id: z.string().uuid(), upload_url: z.string().url(), method: z.literal('PUT') });

export async function uploadCloudMedia(filePath: string, options: CloudOptions & { pendingOperationId?: string }, fetchImpl: typeof fetch = fetch) {
  // Check configuration before reading local data; never forward the project key to Storage.
  cloud(options);
  const file = await new LocalMediaResolver().inspect(resolve(filePath), { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: PROJECT_MEDIA_TYPES });
  const metadata = { name: file.name, content_type: file.contentType, byte_length: file.bytes.byteLength, sha256: file.sha256 };
  const prepared = receipt.parse(await cloudTool('media_prepare_upload', { ...metadata, ...(options.pendingOperationId ? { pending_operation_id: options.pendingOperationId } : {}) }, options, fetchImpl));
  if (!options.pendingOperationId) return prepared;
  const parsedGrant = uploadGrant.safeParse(prepared.result?.details);
  if (prepared.status !== 'applied' || prepared.applied !== true || !parsedGrant.success || !prepared.result?.resourceIds?.includes(parsedGrant.data.media_id)) throw new AdportError('PROVIDER_ERROR', 'Cloud did not return an approved upload grant. No bytes were sent.');
  const grant = parsedGrant.data;
  const destination = new URL(grant.upload_url), local = new URL(options.cloudUrl);
  const storageHost = destination.hostname.endsWith('.supabase.co') || (['localhost', '127.0.0.1'].includes(local.hostname) && ['localhost', '127.0.0.1'].includes(destination.hostname));
  if (!storageHost || (destination.protocol !== 'https:' && destination.hostname !== '127.0.0.1' && destination.hostname !== 'localhost') || destination.username || destination.password || !destination.pathname.startsWith('/storage/v1/object/upload/sign/creative-media/') || !destination.pathname.endsWith(`/${grant.media_id}`) || grant.method !== 'PUT') throw new AdportError('PROVIDER_ERROR', 'Cloud upload destination could not be verified. No bytes were sent.');
  try {
    const response = await fetchImpl(destination, { method: 'PUT', redirect: 'error', headers: { 'content-type': file.contentType, 'x-upsert': 'false' }, body: file.bytes, signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error('Storage upload failed');
    const args = { media_id: grant.media_id, expected_sha256: file.sha256 };
    const preview = receipt.parse(await cloudTool('media_finalize_upload', args, options, fetchImpl));
    if (preview.status !== 'pending_validation' || typeof preview.pending_operation_id !== 'string') throw new Error('Finalization preview failed');
    const finalized = receipt.parse(await cloudTool('media_finalize_upload', { ...args, pending_operation_id: preview.pending_operation_id }, options, fetchImpl));
    if (finalized.status !== 'applied' || finalized.applied !== true || !finalized.result?.resourceIds?.includes(grant.media_id)) throw new Error('Finalization was not confirmed');
    return finalized;
  } catch { throw new AdportError('PROVIDER_ERROR', 'File transfer or verification was not confirmed. Inspect media_get for this ID before retrying.', { media_id: grant.media_id, sha256: file.sha256 }); }
}

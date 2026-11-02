import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { readWorkspaceLogo, updateWorkspaceLogo } from '@/lib/cloud/workspace-logos';
import { MAX_LOGO_BYTES, workspaceLogoUrl } from '@/lib/workspace-logos';
import { apiError, HttpError, noStoreJson } from '@/lib/http';

const paramsSchema = z.object({ kind: z.enum(['project', 'organization']), id: z.string().uuid() });
type Context = { params: Promise<{ kind: string; id: string }> };

async function actor(): Promise<string> {
  const { data, error } = await (await createClient()).auth.getUser();
  if (error || !data.user) throw new HttpError('Sign in to continue.', 401);
  return data.user.id;
}

async function uploadFile(request: Request): Promise<File> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new HttpError('Choose an image to upload.', 400);
  const limit = MAX_LOGO_BYTES + 65_536;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError('Choose an image up to 2 MB.', 413);
  if (!request.body) throw new HttpError('Choose an image to upload.', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError('Choose an image up to 2 MB.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData(); }
  catch { throw new HttpError('The upload could not be read. Please try again.', 400); }
  const file = form.get('file');
  if (!(file instanceof File)) throw new HttpError('Choose an image to upload.', 400);
  return file;
}

export async function GET(_request: Request, context: Context) {
  try {
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) throw new HttpError('Logo not found.', 404);
    const { kind, id } = parsed.data;
    const image = await readWorkspaceLogo(await actor(), kind, id);
    return new Response(image, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) { return apiError(error); }
}

async function mutate(request: Request, context: Context, remove: boolean) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) throw new HttpError('Invalid logo target.', 400);
    const { kind, id } = parsed.data;
    const userId = await actor();
    if (!await enforceRateLimit(`workspace-logo:${userId}`, 30)) throw new HttpError('Too many changes. Please try again in a minute.', 429);
    const path = await updateWorkspaceLogo(userId, kind, id, remove ? null : await uploadFile(request));
    revalidatePath('/dashboard', 'layout');
    return noStoreJson({ logoUrl: workspaceLogoUrl(kind, id, path) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) { return mutate(request, context, false); }
export async function DELETE(request: Request, context: Context) { return mutate(request, context, true); }

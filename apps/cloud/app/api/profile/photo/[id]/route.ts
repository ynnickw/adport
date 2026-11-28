import { z } from 'zod';
import { readProfilePhoto, requireProfileUser } from '@/lib/cloud/profile';
import { apiError, HttpError } from '@/lib/http';

export async function GET(_request: Request, context: RouteContext<'/api/profile/photo/[id]'>) {
  try {
    await requireProfileUser();
    // The scoped profile and team reads issue opaque IDs. A replacement retires the previous ID.
    const parsed = z.uuidv4().safeParse((await context.params).id);
    if (!parsed.success) throw new HttpError('Profile photo not found.', 404);
    const image = await readProfilePhoto(parsed.data);
    return new Response(new Uint8Array(image), {
      headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) { return apiError(error); }
}

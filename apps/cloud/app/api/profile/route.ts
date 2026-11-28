import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { readImageUploadForm } from '@/lib/cloud/image-upload';
import { requireProfileUser, updateProfile } from '@/lib/cloud/profile';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { env } from '@/lib/env';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { MAX_PROFILE_PHOTO_BYTES } from '@/lib/member-profiles';

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  photoAction: z.enum(['keep', 'replace', 'remove']),
});

export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') !== new URL(env().ADPORT_CLOUD_BASE_URL).origin) throw new HttpError('Invalid request origin.', 403);
    const userId = await requireProfileUser();
    if (!await enforceRateLimit(`profile:${userId}`, 20)) throw new HttpError('Too many changes. Try again in a minute.', 429);
    const form = await readImageUploadForm(request, MAX_PROFILE_PHOTO_BYTES);
    const input = profileSchema.safeParse({ displayName: form.get('displayName'), photoAction: form.get('photoAction') });
    if (!input.success) throw new HttpError('Check your photo selection and enter a display name between 1 and 120 characters.', 400);
    const file = form.get('file');
    if (input.data.photoAction === 'replace' && !(file instanceof File)) throw new HttpError('Choose a profile photo.', 400);
    const photo = input.data.photoAction === 'replace' && file instanceof File
      ? file : input.data.photoAction === 'remove' ? null : undefined;
    const profile = await updateProfile(userId, input.data.displayName, photo);
    revalidatePath('/dashboard', 'layout');
    return noStoreJson(profile);
  } catch (error) { return apiError(error); }
}

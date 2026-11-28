import 'server-only';
import { db } from '@/lib/db';
import { HttpError } from '@/lib/http';
import { MAX_PROFILE_PHOTO_BYTES, safeProfileAvatarUrl } from '@/lib/member-profiles';
import { createClient } from '@/lib/supabase/server';

export async function requireProfileUser(): Promise<string> {
  const { data, error } = await (await createClient()).auth.getUser();
  if (error || !data.user) throw new HttpError('Sign in to continue.', 401);
  return data.user.id;
}

export async function updateProfile(userId: string, displayName: string, photo: File | null | undefined) {
  let image: Buffer | null = null;
  if (photo) {
    const { normalizeUploadedImage } = await import('./image-upload');
    image = await normalizeUploadedImage(photo, MAX_PROFILE_PHOTO_BYTES, decoded =>
      decoded.resize(192, 192, { fit: 'cover' }).webp({ quality: 84 }).toBuffer());
  }
  return db().begin(async sql => {
    const [profile] = await sql<Array<{ displayName: string }>>`
      update public.profiles set display_name = ${displayName} where user_id = ${userId} returning display_name`;
    if (!profile) throw new HttpError('Your profile could not be found.', 404);
    if (photo !== undefined) await sql`
      insert into private.profile_photos (user_id, image_id, image)
      values (${userId}, case when ${Boolean(image)} then gen_random_uuid() end, ${image})
      on conflict (user_id) do update set image_id = excluded.image_id, image = excluded.image`;
    const [current] = await sql<Array<{ avatarUrl: string | null }>>`
      select private.profile_avatar_url(${userId}) as avatar_url`;
    return { ...profile, avatarUrl: safeProfileAvatarUrl(current?.avatarUrl ?? null) };
  });
}

export async function readProfilePhoto(imageId: string): Promise<Buffer> {
  const [photo] = await db()<Array<{ image: Buffer }>>`
    select image from private.profile_photos where image_id = ${imageId}`;
  if (!photo) throw new HttpError('Profile photo not found.', 404);
  return photo.image;
}

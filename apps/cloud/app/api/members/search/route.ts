import { z } from 'zod';
import { findInviteProfiles } from '@/lib/cloud/member-profiles';
import { enforceRateLimit } from '@/lib/cloud/repository';
import { apiError, HttpError, noStoreJson } from '@/lib/http';
import { createClient } from '@/lib/supabase/server';

const searchSchema = z.object({
  scope: z.enum(['organization', 'project']),
  targetId: z.uuid(),
  query: z.string().trim().min(2).max(320),
});

export async function POST(request: Request) {
  try {
    const { data, error } = await (await createClient()).auth.getUser();
    if (error || !data.user) throw new HttpError('Sign in to search profiles.', 401);
    const input = searchSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new HttpError('Enter a name or email address to search.', 400);
    if (!await enforceRateLimit(`member-profile-search:${data.user.id}`, 60)) {
      throw new HttpError('Too many searches. Try again in a minute.', 429);
    }
    const { targetId, scope, query } = input.data;
    return noStoreJson({ profiles: await findInviteProfiles(data.user.id, targetId, scope, query) });
  } catch (error) {
    return apiError(error);
  }
}

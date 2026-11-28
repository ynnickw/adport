import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/db';
import { safeProfileAvatarUrl, type InviteProfile, type InviteProfileScope } from '@/lib/member-profiles';

export async function findInviteProfiles(actorId: string, targetId: string, scope: InviteProfileScope, query: string): Promise<InviteProfile[]> {
  const email = query.toLowerCase();
  const exactEmail = z.email().safeParse(email).success ? email : null;
  const profiles = await db()<InviteProfile[]>`
    select * from private.invite_profile_matches(${actorId}, ${targetId}, ${scope === 'project'}, ${query}, ${exactEmail})
  `;
  return profiles.map(profile => ({ ...profile, avatarUrl: safeProfileAvatarUrl(profile.avatarUrl) }));
}

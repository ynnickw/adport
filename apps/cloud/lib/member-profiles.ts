export type InviteProfileScope = 'organization' | 'project';

export interface InviteProfile {
  displayName: string;
  email: string;
  avatarUrl: string | null;
  alreadyHasAccess: boolean;
}

export const PROFILE_AVATAR_ORIGINS = [
  'https://lh3.googleusercontent.com',
  'https://avatars.githubusercontent.com',
];
export const MAX_PROFILE_PHOTO_BYTES = 4 * 1024 * 1024;

const profilePhotoPath = /^\/api\/profile\/photo\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function safeProfileAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  if (profilePhotoPath.test(value)) return value;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && PROFILE_AVATAR_ORIGINS.includes(url.origin)
    ? url.href : null;
}

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

export function safeProfileAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && PROFILE_AVATAR_ORIGINS.includes(url.origin)
    ? url.href : null;
}

'use client';

import { useState } from 'react';

export function ProfileIdentity({ name, email, avatarUrl, isSelf }: {
  name: string;
  email: string;
  avatarUrl?: string | null;
  isSelf?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const initial = Array.from(name.trim() || email.trim())[0]?.toUpperCase() ?? '?';

  return <span className="identity profile-identity">
    <span className="avatar profile-avatar" aria-hidden="true">
      {initial}
      {avatarUrl && avatarUrl !== failedUrl ? (
        <img src={avatarUrl} alt="" width={32} height={32} loading="lazy" referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)} />
      ) : null}
    </span>
    <span className="profile-identity-copy">
      <strong>{name}</strong>{isSelf ? <span className="person-you">You</span> : null}
      <span className="person-email">{email}</span>
    </span>
  </span>;
}

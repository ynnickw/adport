'use client';

import { useState } from 'react';

export function WorkspaceLogo({ name, logoUrl, className = '' }: { name: string; logoUrl?: string | null; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = logoUrl && logoUrl !== failedUrl;
  return <span className={`workspace-logo ${className}${showImage ? ' has-image' : ''}`} aria-hidden="true">
    {showImage ? <img src={logoUrl} alt="" width={64} height={64} draggable={false} onError={() => setFailedUrl(logoUrl)} /> : name.slice(0, 1).toUpperCase()}
  </span>;
}

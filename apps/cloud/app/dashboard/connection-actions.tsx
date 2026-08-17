'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function DisconnectGoogle({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  async function disconnect() {
    if (!window.confirm('Disconnect Google Ads and revoke Adport Cloud access?')) return;
    const response = await fetch(`/api/connections/google?organization_id=${organizationId}`, { method: 'DELETE' });
    if (!response.ok) setError('Unable to disconnect Google Ads.');
    else router.refresh();
  }
  return <>{error ? <span className="error">{error}</span> : null}<button className="button danger" onClick={disconnect}>Disconnect</button></>;
}

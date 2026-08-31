'use client';

import { useEffect, useState } from 'react';
import { BrandLockup } from '@/components/logos';
import { popupChannelName } from '@/lib/oauth-popup';

export function PopupComplete({ popupId, next }: { popupId?: string; next: string }) {
  const [received, setReceived] = useState(false);
  useEffect(() => {
    if (!popupId || typeof window.BroadcastChannel !== 'function') return;
    let channel: BroadcastChannel;
    try { channel = new window.BroadcastChannel(popupChannelName(popupId)); } catch { return; }
    channel.onmessage = event => {
      if (event.data?.type !== 'adport:oauth-received' || event.data?.popupId !== popupId) return;
      setReceived(true);
      window.close();
    };
    channel.postMessage({ type: 'adport:oauth-complete', popupId, next });
    return () => channel.close();
  }, [popupId, next]);
  const failed = new URL(next, 'https://adport.invalid').searchParams.has('error');
  return <main className="onboarding-page">
    <header className="onboarding-head"><BrandLockup /></header>
    <section className="card oauth-popup-complete">
      <h1>{failed ? 'Authorization needs attention' : 'Return to Adport'}</h1>
      <p>{received ? 'Your main window is ready. You can close this popup.' : 'Returning you to the main window. If it is no longer open, continue here.'}</p>
      <a className="button" href={next}>Continue in this window</a>
    </section>
  </main>;
}

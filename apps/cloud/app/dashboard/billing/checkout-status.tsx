'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/controls';

export function CheckoutStatus({ ready, planName }: { ready: boolean; planName: string }) {
  const router = useRouter();
  const attempts = useRef(0);
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setInterval(() => {
      attempts.current += 1;
      router.refresh();
      if (attempts.current >= 15) { clearInterval(timer); setDelayed(true); }
    }, 2000);
    return () => clearInterval(timer);
  }, [ready, router]);
  return <div className={'callout plan-notice' + (ready ? ' success' : '')} role="status">
    {ready ? 'Your ' + planName + ' plan is ready.' : delayed ? 'Your subscription confirmation is taking longer than usual. Refresh the plan or contact support if it does not appear.' : 'Finalizing your subscription. This page will update when Stripe confirms it.'}
    {!ready ? <Button className="button secondary small" type="button" onClick={() => router.refresh()}>Refresh plan</Button> : null}
  </div>;
}

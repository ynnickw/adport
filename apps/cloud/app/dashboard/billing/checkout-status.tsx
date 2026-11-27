'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/controls';
import { InfoToast, SuccessToast } from '@/components/toast';

export function CheckoutStatus({ status, planName }: { status: 'ready' | 'pending' | 'canceled'; planName: string }) {
  if (status === 'canceled') return <InfoToast message="Checkout canceled. Your current plan is unchanged." />;
  if (status === 'ready') return <SuccessToast message={`Your ${planName} plan is ready.`} />;
  return <CheckoutPending />;
}

function CheckoutPending() {
  const router = useRouter();
  const attempts = useRef(0);
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      attempts.current += 1;
      router.refresh();
      if (attempts.current >= 15) { clearInterval(timer); setDelayed(true); }
    }, 2000);
    return () => clearInterval(timer);
  }, [router]);
  return <div className="callout plan-notice" role="status">
    {delayed ? 'Your subscription confirmation is taking longer than usual. Refresh the plan or contact support if it does not appear.' : 'Finalizing your subscription. This page will update when Stripe confirms it.'}
    <Button className="button secondary small" type="button" onClick={() => router.refresh()}>Refresh plan</Button>
  </div>;
}

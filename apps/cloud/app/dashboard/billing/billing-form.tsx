'use client';

import { useActionState } from 'react';
import { Button } from '@/components/controls';
import type { BillingActionState } from './actions';

export function BillingForm({ action, label, pendingLabel, className }: {
  action: (state: BillingActionState, form: FormData) => Promise<BillingActionState>;
  label: string;
  pendingLabel: string;
  className: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return <form action={formAction} className="billing-action-form">
    {state.error ? <p role="alert" className="field-error">{state.error}</p> : null}
    <Button type="submit" disabled={pending} className={className}>{pending ? pendingLabel : label}</Button>
  </form>;
}

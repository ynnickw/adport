'use client';

import { startTransition, useActionState, type FormEvent } from 'react';
import { Button } from '@/components/controls';
import type { BillingActionState } from './actions';
import { useConfirm } from '@/components/use-confirm';

export function BillingForm({ action, label, pendingLabel, className, confirmation }: {
  action: (state: BillingActionState, form: FormData) => Promise<BillingActionState>;
  label: string;
  pendingLabel: string;
  className: string;
  confirmation?: { title: string; description: string; confirmLabel: string };
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const [confirm, dialog] = useConfirm();
  function submit(event: FormEvent<HTMLFormElement>) {
    if (!confirmation) return;
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void confirm(confirmation).then(accepted => { if (accepted) startTransition(() => formAction(data)); });
  }
  return <form action={formAction} onSubmit={submit} className="billing-action-form">
    {dialog}
    {state.error ? <p role="alert" className="field-error">{state.error}</p> : null}
    <Button type="submit" disabled={pending} className={className}>{pending ? pendingLabel : label}</Button>
  </form>;
}

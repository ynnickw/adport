'use client';

import { useActionState } from 'react';
import { Button, Input } from '@/components/controls';
import { requestPasswordReset } from './actions';

export function RecoveryRequestForm({ returnTo }: { returnTo: string }) {
  const [state, action, pending] = useActionState(requestPasswordReset, {});
  if (state.sent) return <p className="callout success" role="status">If an account uses this address, you will receive a password-reset link. Check your inbox and spam folder.</p>;
  return <form action={action} className="form">
    <input type="hidden" name="return_to" value={returnTo} />
    <label className="field">Email<Input name="email" type="email" autoComplete="email" required placeholder="you@company.com" /></label>
    {state.error ? <p className="error-callout" role="alert">{state.error}</p> : null}
    <Button className="button full" type="submit" disabled={pending}>{pending ? 'Sending…' : 'Send reset link'}</Button>
  </form>;
}

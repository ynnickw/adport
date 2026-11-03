'use client';

import { useActionState, useState } from 'react';
import { Button, Input } from '@/components/controls';
import { requestEmailLink } from './actions';

export function EmailLinkForm({ returnTo }: { returnTo: string }) {
  const [state, action, pending] = useActionState(requestEmailLink, {});
  const [email, setEmail] = useState('');
  if (state.sent) return <p className="callout success" role="status">If an account uses this address, you will receive a sign-in link. Open it in this browser to continue.</p>;
  return <form action={action} className="form">
    <input type="hidden" name="return_to" value={returnTo} />
    <label className="field">Email<Input name="email" type="email" autoComplete="email" required placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} /></label>
    {state.error ? <p className="error-callout" role="alert">{state.error}</p> : null}
    <Button className="button full" type="submit" disabled={pending}>{pending ? 'Sending…' : 'Send sign-in link'}</Button>
  </form>;
}

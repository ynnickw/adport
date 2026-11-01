'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/browser';
import { invitationTokens } from '@/lib/invitations';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import { Button, Input } from '@/components/controls';

export function InviteAcceptance({ projectId }: { projectId: string }) {
  const started = useRef(false);
  const [email, setEmail] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const hash = window.location.hash;
    // Default Supabase invitation links use an implicit session. Remove the
    // credentials before creating the browser client or rendering any UI.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void (async () => {
      const tokens = invitationTokens(hash);
      const supabase = createClient();
      if (tokens) {
        const session = await supabase.auth.setSession(tokens);
        if (session.error) throw new Error('This invitation is invalid or expired. Ask your organization admin for a new invitation.');
      }
      const result = await supabase.auth.getUser();
      if (result.error || !result.data.user) throw new Error('Open the invitation link from your email to continue.');
      setEmail(result.data.user.email ?? 'your invited account');
    })().catch(error => setError(error instanceof Error ? error.message : 'The invitation could not be verified.'));
  }, []);

  function finish(form: FormData) {
    startTransition(async () => {
      setError(undefined);
      const password = String(form.get('password') ?? '');
      if (password.length < 12 || password !== form.get('confirmation')) {
        setError('Use a password of at least 12 characters and enter it twice.');
        return;
      }
      try {
        const result = await createClient().auth.updateUser({ password });
        if (result.error) { setError('Your password could not be saved. Please try again.'); return; }
        const selection = new FormData(); selection.set('projectId', projectId);
        await selectProjectAction(selection);
      } catch (reason) {
        if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
        setError('Your project access could not be confirmed. Check your connection or ask an organization admin to review your invitation.');
      }
    });
  }

  return <>
    {email ? <p>Signed in as <strong>{email}</strong>. Create a password to finish joining your project.</p> : !error ? <p role="status">Verifying your invitation…</p> : null}
    {error ? <div className="error-callout" role="alert">{error}</div> : null}
    {email ? <form action={finish} className="form">
      <label>Password<Input type="password" name="password" autoComplete="new-password" minLength={12} required /></label>
      <label>Confirm password<Input type="password" name="confirmation" autoComplete="new-password" minLength={12} required /></label>
      <Button className="button" disabled={pending}>{pending ? 'Joining…' : 'Join project'}</Button>
    </form> : null}
    <p className="auth-switch"><Link href="/login">Back to sign in</Link></p>
  </>;
}

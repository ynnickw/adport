'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Input } from '@/components/controls';
import { createClient } from '@/lib/supabase/browser';
import { passwordRecoveryTokens } from '@/lib/password-recovery';

export function ResetPasswordForm({ returnTo, invalidLink }: { returnTo: string; invalidLink: boolean }) {
  const started = useRef(false);
  const [ready, setReady] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(invalidLink ? 'This reset link is invalid or expired. Request a new one.' : '');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const hash = window.location.hash;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (invalidLink) return;
    void (async () => {
      const tokens = passwordRecoveryTokens(hash);
      const supabase = createClient();
      if (tokens && (await supabase.auth.setSession(tokens)).error) throw new Error('This reset link is invalid or expired. Request a new one.');
      const result = await supabase.auth.getUser();
      if (result.error || !result.data.user) throw new Error('Open the password-reset link from your email to continue.');
      setReady(true);
    })().catch(() => setError('This reset link is invalid or expired. Request a new one.'));
  }, [invalidLink]);
  async function save(form: FormData) {
    const password = String(form.get('password') ?? '');
    if (password.length < 12 || password !== form.get('confirmation')) { setError('Use at least 12 characters and enter the same password twice.'); return; }
    setBusy(true); setError('');
    try {
      const result = await createClient().auth.updateUser({ password });
      if (result.error) setError('Your password could not be saved. Try a different password or request a new reset link.');
      else setComplete(true);
    } catch { setError('Your password could not be saved. Check your connection and try again.'); }
    finally { setBusy(false); }
  }
  if (complete) return <><p className="callout success" role="status">Your password has been updated.</p><Link className="button full" href={returnTo}>Continue to Adport</Link></>;
  return <>
    {!ready && !error ? <p role="status">Verifying your reset link…</p> : null}
    {error ? <p className="error-callout" role="alert">{error}</p> : null}
    {ready ? <form action={save} className="form"><label className="field">New password<Input type="password" name="password" autoComplete="new-password" minLength={12} required /></label><label className="field">Confirm password<Input type="password" name="confirmation" autoComplete="new-password" minLength={12} required /></label><Button className="button full" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</Button></form> : null}
    <p className="auth-switch"><Link href={'/login/forgot-password?return_to=' + encodeURIComponent(returnTo)}>Request a new reset link</Link></p>
  </>;
}

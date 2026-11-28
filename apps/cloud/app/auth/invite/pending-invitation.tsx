'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { WorkspaceForm } from '@/components/workspace-form';
import { createClient } from '@/lib/supabase/browser';
import { invitationTokens, pendingInvitationPath } from '@/lib/invitations';
import { TEAM_ROLES } from '@/lib/team-roles';
import { acceptInvitationAction, readInvitationAction } from './actions';

export function PendingInvitation({ token }: { token: string }) {
  const started = useRef(false);
  const [view, setView] = useState<Awaited<ReturnType<typeof readInvitationAction>>>();
  const [error, setError] = useState<string>();
  const destination = encodeURIComponent(pendingInvitationPath(token));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const hash = window.location.hash;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    void (async () => {
      const tokens = invitationTokens(hash, true);
      if (tokens) {
        const result = await createClient().auth.setSession(tokens);
        if (result.error) throw new Error('This sign-in link has expired. Request a fresh email link to continue.');
      }
      setView(await readInvitationAction(token));
    })().catch(reason => setError(reason instanceof Error ? reason.message : 'The invitation could not be loaded.'));
  }, [token]);

  if (view?.status === 'ready') {
    const role = TEAM_ROLES[view.role];
    return <>
      <h1>{view.projectName ? `Join ${view.projectName}` : `Join ${view.organizationName}`}</h1>
      <p>Signed in as <strong>{view.email}</strong>.</p>
      <p><strong>{role.label}</strong> · {role[view.projectName ? 'project' : 'organization']}</p>
      {view.projectNames.length ? <p>Projects include {view.projectNames.join(', ')}.</p> : null}
      <WorkspaceForm action={acceptInvitationAction} label={`Accept as ${role.label}`}>
        <input type="hidden" name="token" value={token} />
      </WorkspaceForm>
    </>;
  }

  return <>
    <h1>Accept your invitation</h1>
    {!view && !error ? <p role="status">Checking your invitation…</p> : <>
      {error ? <p className="field-error" role="alert">{error}</p>
        : <p>{view?.status === 'unavailable'
          ? 'This invitation may have expired, or it may belong to another account. Use the email address that received it.'
          : 'Sign in with the email address that received the invitation.'}</p>}
      <div className="form">
        <Link className="button" prefetch={false} href={'/login/email-link?return_to=' + destination}>Send me a sign-in link</Link>
        <Link className="button secondary" prefetch={false} href={'/login?return_to=' + destination}>Other sign-in options</Link>
      </div>
    </>}
  </>;
}

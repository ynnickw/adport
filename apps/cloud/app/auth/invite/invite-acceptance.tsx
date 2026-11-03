'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/browser';
import { invitationTokens } from '@/lib/invitations';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import { Button } from '@/components/controls';

export function InviteAcceptance({ projectId }: { projectId: string }) {
  const started = useRef(false);
  const [email, setEmail] = useState<string>();
  const [projectName, setProjectName] = useState<string>();
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
      if (!projectId) throw new Error('Open the invitation link from your email to continue.');
      const project = await supabase.from('organizations').select('name').eq('id', projectId).is('archived_at', null).maybeSingle();
      if (project.error || !project.data) throw new Error('This project is unavailable or you do not have access. Ask your organization admin to review your invitation.');
      setProjectName(project.data.name);
      setEmail(result.data.user.email ?? 'your invited account');
    })().catch(error => setError(error instanceof Error ? error.message : 'The invitation could not be verified.'));
  }, []);

  function finish() {
    startTransition(async () => {
      setError(undefined);
      try {
        const selection = new FormData(); selection.set('projectId', projectId);
        await selectProjectAction(selection);
      } catch (reason) {
        if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
        setError('Your project access could not be confirmed. Check your connection or ask an organization admin to review your invitation.');
      }
    });
  }

  return <>
    <h1>{projectName ? <>Join {projectName}.</> : 'Join your team.'}</h1>
    {email ? <p>Signed in as <strong>{email}</strong>. You’re ready to join your project.</p> : !error ? <p role="status">Verifying your invitation…</p> : null}
    {error ? <div className="error-callout" role="alert">{error}</div> : null}
    {email ? <form action={finish} className="form">
      <Button className="button" disabled={pending}>{pending ? 'Joining…' : 'Join project'}</Button>
    </form> : null}
    <p className="auth-switch"><Link href={'/login?return_to=' + encodeURIComponent(`/auth/invite?project_id=${encodeURIComponent(projectId)}`)}>Back to sign in</Link></p>
  </>;
}

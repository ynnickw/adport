'use client';

import { useActionState } from 'react';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';

export function WorkspaceForm({ action, children, label = 'Save changes', danger = false }: {
  action: (state: WorkspaceActionState, form: FormData) => Promise<WorkspaceActionState>;
  children: React.ReactNode;
  label?: string;
  danger?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="form workspace-form">
      {children}
      {state.error ? <p className="error-callout" role="alert">{state.error}</p> : null}
      {state.success ? <p className="callout success" role="status">{state.success}</p> : null}
      <div><button className={`button ${danger ? 'danger' : 'secondary'}`} disabled={pending}>{pending ? 'Saving…' : label}</button></div>
    </form>
  );
}

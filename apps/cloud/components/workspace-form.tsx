'use client';

import { Button } from '@/components/controls';

import { startTransition, useActionState, useState, type FormEvent } from 'react';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';
import { useConfirm } from './use-confirm';
import { PlanLimitModal } from './plan-limit-modal';
import type { PlanLimitDetails } from '@/lib/cloud/plan-limit';

export function WorkspaceForm({ action, children, label = 'Save changes', danger = false, confirmation, successMessage }: {
  action: (state: WorkspaceActionState, form: FormData) => Promise<WorkspaceActionState>;
  children: React.ReactNode;
  label?: string;
  danger?: boolean;
  confirmation?: { title: string; description: string; confirmLabel: string };
  successMessage?: string;
}) {
  const [confirm, confirmationDialog] = useConfirm();
  const [dismissedLimit, setDismissedLimit] = useState<PlanLimitDetails>();
  const [state, formAction, pending] = useActionState(action, {});
  function submit(event: FormEvent<HTMLFormElement>) {
    if (!confirmation) return;
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void confirm(confirmation).then(accepted => {
      if (accepted) startTransition(() => formAction(form));
    });
  }
  return (
    <form action={formAction} onSubmit={submit} className="form workspace-form">
      {confirmationDialog}
      <PlanLimitModal limit={state.planLimit !== dismissedLimit ? state.planLimit : undefined} onClose={() => setDismissedLimit(state.planLimit)} />
      {children}
      {state.error ? <p className="error-callout" role="alert">{state.error}</p> : null}
      {state.success ? <p className="callout success" role="status">{successMessage ?? state.success}</p> : null}
      <div><Button className={`button ${danger ? 'danger' : 'secondary'}`} disabled={pending}>{pending ? 'Saving…' : label}</Button></div>
    </form>
  );
}

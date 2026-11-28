'use client';

import { Button } from '@/components/controls';

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from 'react';
import { useToast } from './toast';
import type { WorkspaceActionState } from '@/app/dashboard/projects/actions';
import { useConfirm } from './use-confirm';
import { PlanLimitModal } from './plan-limit-modal';
import type { PlanLimitDetails } from '@/lib/cloud/plan-limit';

export function WorkspaceForm({ action, children, label = 'Save changes', danger = false, secondary = false, confirmation, successMessage, resetOnSuccess = false }: {
  action: (state: WorkspaceActionState, form: FormData) => Promise<WorkspaceActionState>;
  children: React.ReactNode;
  label?: string;
  danger?: boolean;
  secondary?: boolean;
  confirmation?: { title: string; description: string; confirmLabel: string };
  successMessage?: string;
  resetOnSuccess?: boolean;
}) {
  const [confirm, confirmationDialog] = useConfirm();
  const [dismissedLimit, setDismissedLimit] = useState<PlanLimitDetails>();
  const [state, formAction, pending] = useActionState(action, {});
  const toast = useToast();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.success) return;
    if (resetOnSuccess) form.current?.reset();
    toast(successMessage ?? state.success);
  }, [state, resetOnSuccess, successMessage, toast]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    if (!confirmation) { startTransition(() => formAction(data)); return; }
    void confirm(confirmation).then(accepted => {
      if (accepted) startTransition(() => formAction(data));
    });
  }
  return (
    <form ref={form} action={formAction} onSubmit={submit} className="form workspace-form">
      {confirmationDialog}
      <PlanLimitModal limit={state.planLimit !== dismissedLimit ? state.planLimit : undefined} onClose={() => setDismissedLimit(state.planLimit)} />
      {children}
      {!pending && state.error ? <p className="field-error" role="alert">{state.error}</p> : null}
      <div className="workspace-form-actions"><Button type="submit" className={`button${danger ? ' danger' : secondary ? ' secondary small' : ''}`} pending={pending} pendingLabel="Saving…">{label}</Button>
      </div>
    </form>
  );
}

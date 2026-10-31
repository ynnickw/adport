'use client';

import { Button, Input } from '@/components/controls';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { Select } from '@/components/select';
import { useConfirm } from '@/components/use-confirm';

interface Member { userId: string; email: string; displayName: string; role: string; }

export function TeamMembers({ organizationId, currentUserId, currentRole, members }: {
  organizationId: string;
  currentUserId: string;
  currentRole: string;
  members: Member[];
}) {
  const router = useRouter();
  const [confirm, confirmationDialog] = useConfirm();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const canAdminister = currentRole === 'owner' || currentRole === 'admin';
  const roles = [...(currentRole === 'owner' ? [{ value: 'admin', label: 'Admin' }] : []), { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }];

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage({});
    try {
      const response = await fetch('/api/members', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, ...body }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      const limit = planLimitFromResponse(result);
      if (limit) setPlanLimit(limit);
      else if (!response.ok) setMessage({ error: result.error ?? 'The request failed.' });
      else { setMessage({ success }); router.refresh(); }
      return response.ok;
    } catch {
      setMessage({ error: 'Could not save the change. Check your connection and try again.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (await call('POST', { email: data.email, role: data.role }, 'Member added or invited.')) form.reset();
  }

  return (
    <>
      {confirmationDialog}
      <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
      {message.error ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="error-callout" role="alert" style={{ marginBottom: 0 }}>{message.error}</div></div> : null}
      {message.success ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="callout success" role="status">{message.success}</div></div> : null}
      <div className="row-list">
        {members.map((member) => (
          <div className="row-item" key={member.userId}>
            <div>
              <strong>{member.displayName}{member.userId === currentUserId ? <span className="text-muted"> · you</span> : null}</strong>
              <div className="cell-sub">{member.email}</div>
            </div>
            <div className="row-actions">
              {canAdminister && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Select aria-label={`Role for ${member.email}`} value={member.role} options={roles} disabled={busy} onValueChange={role => void call('PATCH', { userId: member.userId, role }, 'Member role updated.')} />
                : <span className="status neutral">{member.role}</span>}
              {canAdminister && member.userId !== currentUserId && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Button className="button danger small" disabled={busy} onClick={async () => { if (await confirm({ title: 'Remove project member?', description: `${member.email} will lose access to this project.`, confirmLabel: 'Remove member' })) void call('DELETE', { userId: member.userId }, 'Member removed.'); }}>Remove</Button>
                : null}
            </div>
          </div>
        ))}
      </div>
      {canAdminister ? (
        <div className="card-body" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <form className="form-row" onSubmit={(event) => void invite(event)}>
            <Input name="email" type="email" required placeholder="colleague@company.com" style={{ flex: 1, minWidth: '14rem' }} aria-label="Email" />
            <Select name="role" defaultValue="member" aria-label="Role" options={roles} />
            <Button className="button secondary" disabled={busy}>Invite</Button>
          </form>
        </div>
      ) : null}
    </>
  );
}

'use client';

import { Button, Input } from '@/components/controls';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { Select } from '@/components/select';
import { useConfirm } from '@/components/use-confirm';
import { TEAM_ROLES } from '@/lib/team-roles';
import { PeopleTable } from '@/components/people-table';
import { DialogTrigger } from '@/components/dialog';

interface Member { userId: string; email: string; displayName: string; role: string; inheritedFromOrganization: boolean; }

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
  const [operation, setOperation] = useState<string>();
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const canAdminister = currentRole === 'owner' || currentRole === 'admin';
  const roles = [...(currentRole === 'owner' ? [{ value: 'admin', label: 'Admin' }] : []), { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }];

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, success: string) {
    if (busy) return false;
    setOperation(method === 'POST' ? 'invite' : method === 'DELETE' ? String(body.userId) : 'role');
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
      setOperation(undefined);
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
      <PeopleTable rows={members.map(member => ({
        id: member.userId, name: member.displayName, email: member.email, isSelf: member.userId === currentUserId,
        access: member.inheritedFromOrganization ? 'Inherited · All projects' : 'This project',
        role: canAdminister && !member.inheritedFromOrganization && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Select aria-label={`Role for ${member.email}`} value={member.role} options={roles} disabled={busy} onValueChange={role => void call('PATCH', { userId: member.userId, role }, 'Member role updated.')} />
                : <span className="status neutral">{TEAM_ROLES[member.role as keyof typeof TEAM_ROLES]?.label ?? member.role}</span>,
        action: canAdminister && !member.inheritedFromOrganization && member.userId !== currentUserId && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Button className="button danger small" aria-label={`Remove ${member.email} from this project`} disabled={busy} pending={operation === member.userId} pendingLabel="Removing…" onClick={async () => { if (await confirm({ title: 'Remove project member?', description: `${member.email} will lose access to this project.`, confirmLabel: 'Remove member' })) void call('DELETE', { userId: member.userId }, 'Member removed.'); }}>Remove</Button>
                : null,
      }))} />
      {canAdminister ? (
        <div className="card-body" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <DialogTrigger label="Invite to project" title="Invite to this project">
            <form className="form" onSubmit={(event) => void invite(event)}>
              <label>Email address<Input name="email" type="email" required placeholder="colleague@company.com" /></label>
              <label>Role<Select name="role" defaultValue="member" aria-label="Role" options={roles} /></label>
              {message.error ? <p className="field-error" role="alert">{message.error}</p> : null}
              {message.success ? <p className="action-result" role="status">{message.success}</p> : null}
              <div><Button className="button" disabled={busy} pending={operation === 'invite'} pendingLabel="Inviting…">Invite</Button></div>
            </form>
          </DialogTrigger>
        </div>
      ) : null}
    </>
  );
}

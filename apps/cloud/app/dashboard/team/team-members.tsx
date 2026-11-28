'use client';

import { Button } from '@/components/controls';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { Select } from '@/components/select';
import { useConfirm } from '@/components/use-confirm';
import { TEAM_ROLES } from '@/lib/team-roles';
import { PeopleTable } from '@/components/people-table';
import { DialogTrigger } from '@/components/dialog';
import { InviteProfileField } from '@/components/invite-profile-field';
import { MemberRoleField, TeamRolesTooltip } from '@/components/team-access-guide';
import { useToast } from '@/components/toast';

interface Member { userId: string; email: string; displayName: string; avatarUrl?: string | null; role: string; inheritedFromOrganization: boolean; }

export function TeamMembers({ organizationId, currentUserId, currentRole, members }: {
  organizationId: string;
  currentUserId: string;
  currentRole: string;
  members: Member[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, confirmationDialog] = useConfirm();
  const [error, setError] = useState<{ operation: 'invite' | 'member'; message: string }>();
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string>();
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const canAdminister = currentRole === 'owner' || currentRole === 'admin';
  const roles = [...(currentRole === 'owner' ? [{ value: 'admin', label: 'Admin' }] : []), { value: 'member', label: 'Member' }, { value: 'viewer', label: 'Viewer' }];

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, success?: string) {
    if (busy) return false;
    setOperation(method === 'POST' ? 'invite' : method === 'DELETE' ? String(body.userId) : 'role');
    setBusy(true);
    setError(undefined);
    const failedOperation = method === 'POST' ? 'invite' : 'member';
    try {
      const response = await fetch('/api/members', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, ...body }) });
      const result = await response.json().catch(() => ({})) as { error?: string };
      const limit = planLimitFromResponse(result);
      if (limit) setPlanLimit(limit);
      else if (!response.ok) setError({ operation: failedOperation, message: result.error ?? 'The request failed.' });
      else {
        toast(success ?? 'Invitation sent. Access starts after they accept.');
        router.refresh();
      }
      return response.ok;
    } catch {
      setError({ operation: failedOperation, message: 'Could not save the change. Check your connection and try again.' });
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
    if (await call('POST', { email: data.email, role: data.role })) form.reset();
  }

  return (
    <section className="settings-section people-settings" aria-labelledby="project-people">
      {confirmationDialog}
      <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
      <div className="settings-section-head">
        <h2 id="project-people">People with access <TeamRolesTooltip scope="project" /></h2>
        <div className="people-card-actions">
          <span className="card-note">{members.length} {members.length === 1 ? 'person' : 'people'}</span>
          {canAdminister ? <DialogTrigger label="Invite to project" title="Invite to this project" className="button secondary small">
            <form className="form" onSubmit={event => void invite(event)}>
              <p className="field-hint">Access starts when the recipient accepts the email invitation.</p>
              <InviteProfileField scope="project" targetId={organizationId} />
              <MemberRoleField scope="project" defaultValue="member" options={roles} />
              {error?.operation === 'invite' ? <p className="field-error" role="alert">{error.message}</p> : null}
              <div><Button className="button" type="submit" disabled={busy} pending={operation === 'invite'} pendingLabel="Inviting…">Send invitation</Button></div>
            </form>
          </DialogTrigger> : null}
        </div>
      </div>
      {error?.operation === 'member' ? <p className="error-callout" role="alert">{error.message}</p> : null}
      <PeopleTable rows={members.map(member => ({
        id: member.userId, name: member.displayName, email: member.email, avatarUrl: member.avatarUrl, isSelf: member.userId === currentUserId,
        access: member.inheritedFromOrganization ? 'Inherited · All projects' : 'This project',
        role: canAdminister && !member.inheritedFromOrganization && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Select aria-label={`Role for ${member.email}`} value={member.role} options={roles} disabled={busy} onValueChange={role => void call('PATCH', { userId: member.userId, role }, 'Member role updated.')} />
                : <span className="status neutral">{TEAM_ROLES[member.role as keyof typeof TEAM_ROLES]?.label ?? member.role}</span>,
        action: canAdminister && !member.inheritedFromOrganization && member.userId !== currentUserId && member.role !== 'owner' && (currentRole === 'owner' || member.role !== 'admin')
                ? <Button className="button danger small" aria-label={`Remove ${member.email} from this project`} disabled={busy} pending={operation === member.userId} pendingLabel="Removing…" onClick={async () => { if (await confirm({ title: 'Remove project member?', description: `${member.email} will lose access to this project.`, confirmLabel: 'Remove member' })) void call('DELETE', { userId: member.userId }, 'Member removed.'); }}>Remove</Button>
                : null,
      }))} />
    </section>
  );
}

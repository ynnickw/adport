import { cancelMemberInvitationAction } from '@/app/dashboard/projects/actions';
import type { PendingInvitation } from '@/lib/cloud/member-invitations';
import { TEAM_ROLES } from '@/lib/team-roles';
import { WorkspaceForm } from './workspace-form';

export function PendingMemberInvitations({ invitations }: { invitations: PendingInvitation[] }) {
  if (!invitations.length) return null;
  return <section className="settings-section" aria-labelledby="pending-invitations-heading">
    <div className="settings-section-head"><h2 id="pending-invitations-heading">Pending invitations</h2></div>
    <ul className="settings-list">
      {invitations.map(invitation => <li className="settings-row" key={invitation.id}>
        <div className="settings-row-copy">
          <strong>{invitation.email}</strong>
          <p className="settings-note">{invitation.previousRole ? 'Ownership invitation' : TEAM_ROLES[invitation.role].label + ' invitation'}</p>
        </div>
        <WorkspaceForm action={cancelMemberInvitationAction} label="Cancel invitation" secondary
          confirmation={{ title: 'Cancel this invitation?', description: `${invitation.email} will need a new link to accept.`, confirmLabel: 'Cancel invitation' }}>
          <input type="hidden" name="invitationId" value={invitation.id} />
        </WorkspaceForm>
      </li>)}
    </ul>
  </section>;
}

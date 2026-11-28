import { useId, type ComponentProps } from 'react';
import { TEAM_ROLES } from '@/lib/team-roles';
import type { InviteProfileScope } from '@/lib/member-profiles';
import { InfoTooltip } from './info-tooltip';
import { Select } from './select';

export function TeamRolesTooltip({ scope }: { scope: InviteProfileScope }) {
  return <InfoTooltip label={scope === 'organization' ? 'Organization roles and project access' : 'Project roles and access'}>
    <dl className="team-role-details">{Object.entries(TEAM_ROLES).map(([role, details]) => <div key={role}>
      <dt>{details.label}</dt>
      <dd>{details[scope]}</dd>
    </div>)}</dl>
    <p className="team-role-note">Owners, admins, and members use a team seat. People with access to a project share its accounts, reports, approvals, and history.</p>
  </InfoTooltip>;
}

export function MemberRoleField({ scope, ...props }: { scope: InviteProfileScope } &
  Pick<ComponentProps<typeof Select>, 'options' | 'value' | 'defaultValue' | 'onValueChange'>) {
  const id = useId();
  return <div className="field">
    <div className="field-label"><label htmlFor={id}>Role</label><TeamRolesTooltip scope={scope} /></div>
    <Select {...props} name="role" id={id} aria-label="Role" />
  </div>;
}

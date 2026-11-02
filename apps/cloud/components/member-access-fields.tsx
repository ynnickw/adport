'use client';

import { useState } from 'react';
import { Checkbox } from './controls';
import { InfoTooltip } from './info-tooltip';
import { Select } from './select';
import { TEAM_ROLES } from '@/lib/team-roles';
import { UpgradeButton } from './upgrade-button';

export function MemberAccessFields({ roles, projects, initialRole, initialProjectIds, seatAvailable, requiredSeats }: {
  roles: Array<{ value: string; label: string }>;
  projects: Array<{ id: string; name: string }>;
  initialRole: string;
  initialProjectIds: string[];
  seatAvailable: boolean;
  requiredSeats?: number;
}) {
  const [role, setRole] = useState(initialRole);
  const [selected, setSelected] = useState(new Set(initialProjectIds));
  const allProjects = role === 'owner' || role === 'admin';
  return <>
    <label>Role<Select name="role" value={role} onValueChange={setRole} aria-label="Organization role"
      options={roles.map(option => ({ ...option, disabled: !seatAvailable && option.value !== 'viewer' }))} /></label>
    <p className="inline-note" aria-live="polite">{TEAM_ROLES[role as keyof typeof TEAM_ROLES]?.description}</p>
    {!seatAvailable ? <p className="member-seat-note">All team seats are in use. Viewer access is free. <UpgradeButton kind="members" required={requiredSeats} message="Your organization has used all of its editing-member seats. Read-only viewers remain free." /></p> : null}
    {allProjects ? <div className="member-project-scope"><strong>All projects</strong><InfoTooltip>Owners and admins can access every project in the organization, including new projects.</InfoTooltip></div>
      : <fieldset className="project-access-fields"><legend>Project access <InfoTooltip>Only the selected projects will be available to this person.</InfoTooltip></legend>
        {projects.map(project => <label className="project-checkbox" key={project.id}><Checkbox name="projectIds" value={project.id} checked={selected.has(project.id)} onChange={event => {
          const checked = event.target.checked; setSelected(current => { const next = new Set(current); if (checked) next.add(project.id); else next.delete(project.id); return next; });
        }} />{project.name}</label>)}
      </fieldset>}
  </>;
}

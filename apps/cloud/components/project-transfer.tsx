'use client';

import { useId, useState } from 'react';
import { transferProjectAction } from '@/app/dashboard/projects/actions';
import { InfoTooltip } from './info-tooltip';
import { Select } from './select';
import { WorkspaceForm } from './workspace-form';

export interface ProjectTransferOptions {
  sourceId: string;
  destinations: Array<{ id: string; name: string }>;
}

export function ProjectTransfer({ project, defaultProject, sourceName, options }: {
  project: { id: string; name: string };
  defaultProject: boolean;
  sourceName: string;
  options: ProjectTransferOptions;
}) {
  const [destinationId, setDestinationId] = useState('');
  const selectId = useId();
  const destination = options.destinations.find(organization => organization.id === destinationId);
  return <section className="project-settings-section">
    <h3 className="settings-inline-label">Transfer project <InfoTooltip label="About transferring projects">Connections, settings, and history move with the project. The destination’s plan and retention limits apply, its owners and admins gain access, and pending approvals are canceled.</InfoTooltip></h3>
    {defaultProject ? <p className="settings-note">The default project stays with this organization’s billing.</p>
      : options.destinations.length === 0 ? <p className="settings-note">You need to own another organization to transfer this project.</p>
      : <WorkspaceForm action={transferProjectAction} label="Review transfer" pendingLabel="Transferring…" disabled={!destination}
          confirmation={destination ? {
            title: `Transfer ${project.name}?`,
            description: `This moves the project from ${sourceName} to ${destination.name}, where owners and admins gain access. Direct project access, pending invitations, and pending approvals will be cleared. Project API keys and project-only assistant connections will be revoked.`,
            confirmLabel: 'Transfer project',
          } : undefined}>
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="sourceOrganizationId" value={options.sourceId} />
          <div className="field">
            <label className="field-label" htmlFor={selectId}>Destination organization</label>
            <Select id={selectId} name="destinationOrganizationId" aria-label="Destination organization" required
              value={destinationId} onValueChange={setDestinationId}
              options={options.destinations.map(organization => ({ value: organization.id, label: organization.name }))} />
          </div>
        </WorkspaceForm>}
  </section>;
}

'use client';

import { useId, useState } from 'react';
import { transferProjectAction } from '@/app/dashboard/projects/actions';
import { Disclosure } from './controls';
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
  return <Disclosure label="Transfer project" className="project-transfer-settings">
    {defaultProject ? <p className="inline-note">The default project is tied to this organization’s billing.</p>
      : options.destinations.length === 0 ? <p className="inline-note">You need to be an Owner of another organization to transfer this project.</p>
      : <WorkspaceForm action={transferProjectAction} label="Review transfer" pendingLabel="Transferring…" disabled={!destination}
          confirmation={destination ? {
            title: `Transfer ${project.name}?`,
            description: `This will move the project from ${sourceName} to ${destination.name}. Direct project access and pending invitations will be cleared. Project API keys and project-only assistant connections will be revoked.`,
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
          <p className="inline-note">Connections, settings, and history move with the project. The destination’s plan and retention limits apply, its Owners and Admins gain access, and pending approvals are canceled.</p>
        </WorkspaceForm>}
  </Disclosure>;
}

'use client';

import { createProjectAction } from '@/app/dashboard/projects/actions';
import { Button, Input } from './controls';
import { Dialog } from './dialog';
import { WorkspaceForm } from './workspace-form';
import { useState } from 'react';

export function NewProjectButton({ organizationId, organizationName }: { organizationId: string; organizationName: string }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" className="button" onClick={() => setOpen(true)}>New project</Button>{open ? <NewProjectDialog organizationId={organizationId} organizationName={organizationName} onClose={() => setOpen(false)} /> : null}</>;
}

export function NewProjectDialog({ organizationId, organizationName, onClose }: { organizationId: string; organizationName: string; onClose: () => void }) {
  return <Dialog title="New project" onClose={onClose}>
    <p className="dialog-description">A separate space for a brand, department, or client in {organizationName}. Your existing plan covers it.</p>
    <WorkspaceForm action={createProjectAction} label="Create project">
      <input type="hidden" name="organizationId" value={organizationId} />
      <label>Project name<Input data-autofocus name="name" required maxLength={120} placeholder="e.g. Product marketing" /></label>
      <p className="inline-note">We’ll help you connect its accounts next. You can skip setup and come back whenever you’re ready.</p>
    </WorkspaceForm>
  </Dialog>;
}

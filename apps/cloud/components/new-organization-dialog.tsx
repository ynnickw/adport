'use client';

import { useState } from 'react';
import { createOrganizationAction } from '@/app/dashboard/projects/actions';
import { Button, Input } from './controls';
import { Dialog } from './dialog';
import { WorkspaceForm } from './workspace-form';

export function NewOrganizationButton() {
  const [open, setOpen] = useState(false);
  return <><Button type="button" className="button secondary small" onClick={() => setOpen(true)}>New organization</Button>{open ? <NewOrganizationDialog onClose={() => setOpen(false)} /> : null}</>;
}

export function NewOrganizationDialog({ onClose }: { onClose: () => void }) {
  return <Dialog title="New organization" onClose={onClose}>
    <p className="dialog-description">A separate company or team with its own members, projects, and plan.</p>
    <WorkspaceForm action={createOrganizationAction} label="Create organization">
      <label>Organization name<Input data-autofocus name="name" required maxLength={120} placeholder="e.g. Acme" /></label>
      <p className="inline-note">For a brand, department, or client within your current organization, create a project instead.</p>
    </WorkspaceForm>
  </Dialog>;
}

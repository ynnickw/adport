'use client';

import { useState, useTransition } from 'react';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import type { ProjectAccess } from '@/lib/cloud/workspaces';
import { Select } from './select';
import { useRouter } from 'next/navigation';
import { Button } from './controls';
import { NewProjectDialog } from './new-project-dialog';

export function ProjectSwitcher({ projects, currentProjectId }: { projects: ProjectAccess[]; currentProjectId: string }) {
  const current = projects.find(project => project.id === currentProjectId);
  const router = useRouter();
  const canManage = current && ['owner', 'admin'].includes(current.organizationRole);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  return <div className="project-switcher">
    <div className="workspace-label-row"><span className="workspace-label">{current?.organizationName}</span>{canManage ? <Button className="project-create-button" type="button" aria-label="New project" title="New project" onClick={() => setCreating(true)}><span aria-hidden="true">+</span></Button> : null}</div>
    <Select id="active-project" aria-label="Switch project" value={currentProjectId} disabled={pending}
      options={[...projects.map(project => ({ value: project.id, label: project.name, group: project.organizationName })), ...(canManage ? [{ value: '__new_project', label: '+ New project', group: 'Workspace' }] : []), { value: '__projects', label: canManage ? 'Manage projects' : 'View projects', group: 'Workspace' }]}
      onValueChange={value => {
        setError('');
        if (value === '__new_project') { setCreating(true); return; }
        if (value === '__projects') { router.push('/dashboard/projects'); return; }
        const form = new FormData(); form.set('projectId', value);
        startTransition(async () => { try { await selectProjectAction(form); } catch (reason) {
          if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
          setError('Could not switch projects. Please try again.');
        } });
      }} />
    {error ? <span className="field-error" role="alert">{error}</span> : null}
    {creating && current && canManage ? <NewProjectDialog organizationId={current.organizationId} organizationName={current.organizationName} onClose={() => setCreating(false)} /> : null}
  </div>;
}

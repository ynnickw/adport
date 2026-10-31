'use client';

import { useState, useTransition } from 'react';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import type { ProjectAccess } from '@/lib/cloud/workspaces';
import { Select } from './select';

export function ProjectSwitcher({ projects, currentProjectId }: { projects: ProjectAccess[]; currentProjectId: string }) {
  const current = projects.find(project => project.id === currentProjectId);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  return <div className="project-switcher">
    <span className="workspace-label">{current?.organizationName}</span>
    <Select id="active-project" aria-label="Switch project" value={currentProjectId} disabled={pending}
      options={projects.map(project => ({ value: project.id, label: project.name, group: project.organizationName }))}
      onValueChange={value => {
        setError('');
        const form = new FormData(); form.set('projectId', value);
        startTransition(async () => { try { await selectProjectAction(form); } catch (reason) {
          if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
          setError('Could not switch projects. Please try again.');
        } });
      }} />
    {error ? <span className="field-error" role="alert">{error}</span> : null}
  </div>;
}

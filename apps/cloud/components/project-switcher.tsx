'use client';

import { useState, useTransition } from 'react';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import type { ProjectAccess } from '@/lib/cloud/workspaces';
import { Select } from './select';
import { useRouter } from 'next/navigation';

export function ProjectSwitcher({ projects, currentProjectId }: { projects: ProjectAccess[]; currentProjectId: string }) {
  const current = projects.find(project => project.id === currentProjectId);
  const router = useRouter();
  const canManage = current && ['owner', 'admin'].includes(current.organizationRole);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  return <div className="project-switcher">
    <span className="workspace-label">{current?.organizationName}</span>
    <Select id="active-project" aria-label="Switch project" value={currentProjectId} disabled={pending}
      options={[...projects.map(project => ({ value: project.id, label: project.name, group: project.organizationName })), { value: '__projects', label: canManage ? 'Create or manage projects' : 'View projects', group: 'Workspace' }]}
      onValueChange={value => {
        setError('');
        if (value === '__projects') { router.push('/dashboard/projects'); return; }
        const form = new FormData(); form.set('projectId', value);
        startTransition(async () => { try { await selectProjectAction(form); } catch (reason) {
          if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
          setError('Could not switch projects. Please try again.');
        } });
      }} />
    {error ? <span className="field-error" role="alert">{error}</span> : null}
  </div>;
}

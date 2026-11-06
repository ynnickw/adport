'use client';

import { useState } from 'react';
import Link from 'next/link';
import { selectProjectAction, updateProjectAction } from '@/app/dashboard/projects/actions';
import { Button, Input } from './controls';
import { Dialog } from './dialog';
import { WorkspaceForm } from './workspace-form';
import { NewOrganizationButton } from './new-organization-dialog';
import { WorkspaceLogo } from './workspace-logo';
import { WorkspaceLogoEditor } from './workspace-logo-editor';
import { workspaceLogoUrl } from '@/lib/workspace-logos';

interface ManagedProject { id: string; name: string; logoPath?: string | null; archivedAt: Date | null; enabledAccounts?: number; }

export function ProjectManager({ projects, currentProjectId, defaultProjectId, organizationName, canManage }: {
  projects: ManagedProject[];
  currentProjectId: string;
  defaultProjectId: string;
  organizationName: string;
  canManage: boolean;
}) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = projects.find(project => project.id === editingId);
  const visible = projects.filter(project => Boolean(project.archivedAt) === archived && project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const activeCount = projects.filter(project => !project.archivedAt).length;
  return <>
    <section className="card project-directory" aria-label={`Projects in ${organizationName}`}>
      <div className="project-directory-toolbar">
        <div className="project-filters" role="group" aria-label="Project status">
          <Button type="button" aria-pressed={!archived} onClick={() => setArchived(false)}>Active <span>{activeCount}</span></Button>
          {canManage ? <Button type="button" aria-pressed={archived} onClick={() => setArchived(true)}>Archived <span>{projects.length - activeCount}</span></Button> : null}
        </div>
        <Input type="search" aria-label="Search projects" placeholder="Find a project…" value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="row-list">{visible.map(project => <div className="row-item project-row" key={project.id}>
        <div className="identity"><WorkspaceLogo name={project.name} logoUrl={workspaceLogoUrl('project', project.id, project.logoPath)} className="project-monogram" /><div><div className="project-row-title"><strong>{project.name}</strong>{project.id === currentProjectId ? <span className="status neutral">Current</span> : null}</div><div className="cell-sub">{project.archivedAt ? 'Archived' : project.id === defaultProjectId ? 'Default project' : 'Project'}{project.enabledAccounts !== undefined ? ` · ${project.enabledAccounts} enabled ${project.enabledAccounts === 1 ? 'ad account' : 'ad accounts'}` : ''}</div></div></div>
        <div className="row-actions">
          {project.id !== currentProjectId && !project.archivedAt ? <form action={selectProjectAction}><input type="hidden" name="projectId" value={project.id} /><Button className="button secondary small" type="submit" aria-label={`Open ${project.name}`}>Open project <span aria-hidden="true">→</span></Button></form> : null}
          {canManage ? <Button type="button" className="button secondary small" aria-label={`Settings for ${project.name}`} onClick={() => setEditingId(project.id)}>Settings</Button> : null}
        </div>
      </div>)}</div>
      {visible.length === 0 ? <div className="project-directory-empty"><h2>{query ? 'No matching projects' : 'No archived projects'}</h2><p>{query ? 'Try another project name.' : 'Projects you archive will appear here. You can restore them anytime.'}</p>{query ? <Button type="button" className="button secondary small" onClick={() => setQuery('')}>Clear search</Button> : null}</div> : null}
    </section>
    <div className="organization-context"><div><strong>{organizationName}</strong><p>{canManage ? 'Manage the team and access across your projects.' : 'Your organization manages membership and project access.'}</p></div><div className="row-actions">{canManage ? <Link className="button secondary small" href="/dashboard/organization">Organization settings</Link> : null}<NewOrganizationButton /></div></div>
    {editing && canManage ? <Dialog title={`Settings for ${editing.name}`} onClose={() => setEditingId(null)}><div className="stack">
      <WorkspaceLogoEditor key={editing.id} kind="project" id={editing.id} name={editing.name} logoUrl={workspaceLogoUrl('project', editing.id, editing.logoPath)} />
      <WorkspaceForm action={updateProjectAction} label="Save name"><input type="hidden" name="projectId" value={editing.id} /><label>Project name<Input data-autofocus name="name" defaultValue={editing.name} required maxLength={120} /></label></WorkspaceForm>
      <div className="project-archive-settings"><h3>{editing.archivedAt ? 'Restore project' : 'Archive project'}</h3><p className="inline-note">{editing.id === defaultProjectId ? 'Your default project is always available and cannot be archived.' : editing.archivedAt ? 'Restore this project, then enable the ad accounts you need.' : 'Suspend access for your team and connected assistants. Your ad campaigns will keep running. You can restore the project later.'}</p>
        {editing.id !== defaultProjectId ? <WorkspaceForm action={updateProjectAction} label={editing.archivedAt ? 'Restore project' : 'Archive project'} danger={!editing.archivedAt} confirmation={!editing.archivedAt ? { title: `Archive ${editing.name}?`, description: 'Adport will disable this project’s account access. Connected assistants cannot use it while archived. Campaigns keep running. You can restore the project later, then enable the accounts you need.', confirmLabel: 'Archive project' } : undefined}><input type="hidden" name="projectId" value={editing.id} /><input type="hidden" name="archived" value={String(!editing.archivedAt)} /></WorkspaceForm> : null}
      </div>
    </div></Dialog> : null}
  </>;
}

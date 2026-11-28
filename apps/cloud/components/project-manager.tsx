'use client';

import { useState } from 'react';
import { updateProjectAction } from '@/app/dashboard/projects/actions';
import { Button, Input } from './controls';
import { FilterButtons, ListToolbar, SearchField } from './list-controls';
import { Dialog } from './dialog';
import { InfoTooltip } from './info-tooltip';
import { WorkspaceForm } from './workspace-form';
import { WorkspaceLogo } from './workspace-logo';
import { WorkspaceLogoEditor } from './workspace-logo-editor';
import { ProjectTransfer, type ProjectTransferOptions } from './project-transfer';
import { workspaceLogoUrl } from '@/lib/workspace-logos';

interface ManagedProject { id: string; name: string; logoPath?: string | null; archivedAt: Date | null; enabledAccounts?: number; }

export function ProjectManager({ projects, currentProjectId, defaultProjectId, organizationName, canManage, dangerZone, transfer, initialStatus = 'active' }: {
  projects: ManagedProject[];
  currentProjectId: string;
  defaultProjectId: string;
  organizationName: string;
  canManage: boolean;
  dangerZone?: React.ReactNode;
  transfer?: ProjectTransferOptions;
  initialStatus?: 'active' | 'archived';
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = projects.find(project => project.id === editingId);
  const search = query.trim().toLocaleLowerCase();
  const visible = projects.filter(project => Boolean(project.archivedAt) === (status === 'archived') && project.name.toLocaleLowerCase().includes(search));
  const activeCount = projects.filter(project => !project.archivedAt).length;
  return <>
    <section className="settings-section project-directory" aria-label={`Projects in ${organizationName}`}>
      <ListToolbar divided filters={<FilterButtons label="Project status" value={status} onChange={setStatus} options={[
        { value: 'active', label: 'Active', count: activeCount },
        ...(canManage ? [{ value: 'archived' as const, label: 'Archived', count: projects.length - activeCount }] : []),
      ]} />}>
        <SearchField aria-label="Search projects" placeholder="Find a project…" value={query} onChange={event => setQuery(event.target.value)} />
      </ListToolbar>
      <div className="row-list">{visible.map(project => <div className="row-item project-row" key={project.id}>
        <div className="identity"><WorkspaceLogo name={project.name} logoUrl={workspaceLogoUrl('project', project.id, project.logoPath)} className="project-monogram" /><div><div className="project-row-title"><strong>{project.name}</strong>{project.id === currentProjectId ? <span className="status neutral">Current</span> : null}</div><div className="cell-sub">{project.archivedAt ? 'Archived' : project.id === defaultProjectId ? 'Default project' : 'Project'}{project.enabledAccounts !== undefined ? ` · ${project.enabledAccounts} enabled ${project.enabledAccounts === 1 ? 'ad account' : 'ad accounts'}` : ''}</div></div></div>
        <div className="row-actions">
          {canManage || project.id === currentProjectId && dangerZone ? <Button type="button" className="button secondary small" aria-label={`Settings for ${project.name}`} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setEditingId(project.id); }}>Settings</Button> : null}
        </div>
      </div>)}</div>
      {visible.length === 0 ? <div className="project-directory-empty">
        <h2>{search ? 'No matching projects' : status === 'archived' ? 'No archived projects' : 'No active projects'}</h2>
        {search ? <><p>Try another project name.</p><Button type="button" className="button secondary small" onClick={() => setQuery('')}>Clear search</Button></>
          : status === 'archived' ? <p>Projects you archive can be restored here.</p> : null}
      </div> : null}
    </section>
    {editing ? <Dialog title={`Settings for ${editing.name}`} onClose={() => setEditingId(null)}><div className="stack">
      {canManage ? <>
      <WorkspaceLogoEditor key={editing.id} kind="project" id={editing.id} name={editing.name} logoUrl={workspaceLogoUrl('project', editing.id, editing.logoPath)} />
      <WorkspaceForm action={updateProjectAction} label="Save name"><input type="hidden" name="projectId" value={editing.id} /><label>Project name<Input data-autofocus name="name" defaultValue={editing.name} required maxLength={120} /></label></WorkspaceForm>
      <div className="settings-row project-settings-row">
        <div className="settings-row-copy">
          <h3 className="settings-inline-label">Availability <InfoTooltip label="About archiving projects">Archiving suspends access for your team and connected assistants. Campaigns keep running. You can restore the project and enable its ad accounts again.</InfoTooltip></h3>
          <p className="settings-note">{editing.id === defaultProjectId ? 'The default project is always available.' : editing.archivedAt ? 'Archived' : 'Active'}</p>
        </div>
        {editing.id !== defaultProjectId ? <WorkspaceForm action={updateProjectAction} label={editing.archivedAt ? 'Restore project' : 'Archive project'} secondary
          confirmation={!editing.archivedAt ? { title: `Archive ${editing.name}?`, description: 'Adport will disable this project’s account access. Connected assistants cannot use it while archived. Campaigns keep running. You can restore the project later, then enable the accounts you need.', confirmLabel: 'Archive project' } : undefined}>
          <input type="hidden" name="projectId" value={editing.id} />
          <input type="hidden" name="archived" value={String(!editing.archivedAt)} />
        </WorkspaceForm> : null}
      </div></> : null}
      {transfer ? <ProjectTransfer project={editing} defaultProject={editing.id === defaultProjectId}
        sourceName={organizationName} options={transfer} /> : null}
      {editing.id === currentProjectId ? dangerZone : null}
    </div></Dialog> : null}
  </>;
}

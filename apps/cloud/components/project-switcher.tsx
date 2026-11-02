'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import type { ProjectAccess } from '@/lib/cloud/workspaces';
import { Button, Input } from './controls';
import { NewProjectDialog } from './new-project-dialog';
import { NewOrganizationDialog } from './new-organization-dialog';
import { WorkspaceLogo } from './workspace-logo';
import { workspaceLogoUrl } from '@/lib/workspace-logos';

function Chevron({ back = false }: { back?: boolean }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d={back ? 'm10 4-4 4 4 4' : 'm4 6 4 4 4-4'} /></svg>;
}

export function ProjectSwitcher({ projects, currentProjectId }: { projects: ProjectAccess[]; currentProjectId: string }) {
  const current = projects.find(project => project.id === currentProjectId);
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'projects' | 'organizations'>('projects');
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState<CSSProperties>({});
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [creating, setCreating] = useState<'project' | 'organization' | null>(null);
  const canManage = current && ['owner', 'admin'].includes(current.organizationRole);
  const organizations = [...new Map(projects.map(project => [project.organizationId, project])).values()];
  const organizationProjects = projects.filter(project => project.organizationId === current?.organizationId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = organizationProjects.filter(project => project.name.toLocaleLowerCase().includes(normalizedQuery));
  const filteredOrganizations = organizations.filter(project => project.organizationName.toLocaleLowerCase().includes(normalizedQuery));

  useEffect(() => { if (open) search.current?.focus(); }, [open, view]);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !panel.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 24);
      const height = Math.min(panel.current.scrollHeight, 560, window.innerHeight - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const top = below >= height || below >= rect.top ? rect.bottom + 6 : rect.top - height - 6;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(12, Math.min(top, window.innerHeight - height - 12)), maxHeight: Math.min(560, window.innerHeight - 24) });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, view]);

  function close() {
    if (panel.current?.matches(':popover-open')) panel.current.hidePopover();
  }
  function changeView(next: typeof view) { setQuery(''); setView(next); }
  function navigate(path: string) { close(); router.push(path); }
  function choose(projectId: string) {
    close();
    if (projectId === currentProjectId) return;
    setError('');
    const form = new FormData();
    form.set('projectId', projectId);
    form.set('return_to', window.location.pathname + window.location.search);
    startTransition(async () => {
      try { await selectProjectAction(form); }
      catch (reason) {
        if (reason instanceof Error && reason.message === 'NEXT_REDIRECT') throw reason;
        setError('Could not switch projects. Please try again.');
      }
    });
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const options = [...(panel.current?.querySelectorAll<HTMLButtonElement>('.workspace-option') ?? [])];
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = index === -1 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    } else if (event.key === 'Enter' && event.target === search.current) {
      event.preventDefault(); options[0]?.click();
    }
  }

  return <div className="project-switcher">
    <Button ref={trigger} type="button" className="workspace-trigger" popoverTarget={menuId} disabled={pending}
      aria-label={`Switch organization or project. ${current?.organizationName}, ${current?.name}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={menuId}>
      <WorkspaceLogo name={current?.organizationName ?? ''} logoUrl={current ? workspaceLogoUrl('organization', current.organizationId, current.organizationLogoPath) : null} className="workspace-avatar" />
      <span className="workspace-trigger-copy"><small title={current?.organizationName}>{current?.organizationName}</small><strong title={current?.name}>{pending ? 'Switching…' : current?.name}</strong></span>
      <Chevron />
    </Button>
    {pending ? <span className="sr-only" role="status">Switching project</span> : null}
    {error ? <span className="field-error" role="alert">{error}</span> : null}
    <div ref={panel} id={menuId} popover="auto" role="dialog" aria-label="Switch organization or project" className="workspace-menu" style={position}
      onToggle={event => {
        const nextOpen = (event.nativeEvent as ToggleEvent).newState === 'open';
        setOpen(nextOpen);
        if (!nextOpen) { setQuery(''); setView('projects'); }
      }} onKeyDown={keyDown} onBlur={event => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) close();
      }}>
      {view === 'projects' ? <Button className="workspace-menu-heading" type="button" onClick={() => changeView('organizations')} aria-label={`Switch organization. Current organization: ${current?.organizationName}`}>
        <span className="workspace-heading-copy"><small>Organization</small><strong>{current?.organizationName}</strong></span><span className="workspace-change">Switch <Chevron /></span>
      </Button> : <div className="workspace-menu-heading"><Button type="button" className="icon-button" aria-label="Back to projects" onClick={() => changeView('projects')}><Chevron back /></Button><strong>Switch organization</strong></div>}
      <div className="workspace-search"><Input ref={search} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={view === 'projects' ? 'Find a project…' : 'Find an organization…'} aria-label={view === 'projects' ? 'Search projects' : 'Search organizations'} /></div>
      <div className="workspace-menu-list">
        <p className="workspace-menu-label">{view === 'projects' ? 'Projects' : 'Your organizations'}</p>
        {view === 'projects' ? filteredProjects.map(project => <Button type="button" className="workspace-option" key={project.id} aria-current={project.id === currentProjectId ? 'true' : undefined} onClick={() => choose(project.id)}>
          <WorkspaceLogo name={project.name} logoUrl={workspaceLogoUrl('project', project.id, project.logoPath)} className="workspace-project-icon" /><span className="workspace-option-copy"><strong>{project.name}</strong><small>{project.id === currentProjectId ? 'Current project' : project.role === 'viewer' ? 'Read-only access' : project.id === project.defaultProjectId ? 'Default project' : 'Project'}</small></span>{project.id === currentProjectId ? <span className="workspace-check" aria-hidden="true">✓</span> : null}
        </Button>) : filteredOrganizations.map(organization => {
          const available = projects.filter(project => project.organizationId === organization.organizationId);
          // A member may not have access to the organization's default project.
          const destination = available.find(project => project.id === organization.defaultProjectId) ?? available[0]!;
          const selected = organization.organizationId === current?.organizationId;
          return <Button type="button" className="workspace-option" key={organization.organizationId} aria-current={selected ? 'true' : undefined} onClick={() => selected ? changeView('projects') : choose(destination.id)}>
            <WorkspaceLogo name={organization.organizationName} logoUrl={workspaceLogoUrl('organization', organization.organizationId, organization.organizationLogoPath)} className="workspace-avatar" /><span className="workspace-option-copy"><strong>{organization.organizationName}</strong><small>{available.length} {available.length === 1 ? 'project' : 'projects'} · {organization.organizationRole}</small></span>{selected ? <span className="workspace-check" aria-hidden="true">✓</span> : null}
          </Button>;
        })}
        {(view === 'projects' ? filteredProjects : filteredOrganizations).length === 0 ? <p className="workspace-menu-empty">No {view} match “{query}”.</p> : null}
      </div>
      <div className="workspace-menu-actions">{view === 'projects' ? <>
        {canManage ? <Button type="button" className="workspace-menu-action" onClick={() => { close(); setCreating('project'); }}><span aria-hidden="true">+</span> New project</Button> : null}
        <Button type="button" className="workspace-menu-action" onClick={() => navigate('/dashboard/projects')}>{canManage ? 'Manage projects' : 'View projects'}<span className="workspace-action-arrow" aria-hidden="true">→</span></Button>
        {canManage ? <Button type="button" className="workspace-menu-action" onClick={() => navigate('/dashboard/organization')}>Organization settings<span className="workspace-action-arrow" aria-hidden="true">→</span></Button> : null}
      </> : <Button type="button" className="workspace-menu-action" onClick={() => { close(); setCreating('organization'); }}><span aria-hidden="true">+</span> New organization</Button>}</div>
    </div>
    {creating === 'project' && current && canManage ? <NewProjectDialog organizationId={current.organizationId} organizationName={current.organizationName} onClose={() => setCreating(null)} /> : null}
    {creating === 'organization' ? <NewOrganizationDialog onClose={() => setCreating(null)} /> : null}
  </div>;
}

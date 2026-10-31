import Link from 'next/link';
import { selectProjectAction } from '@/app/dashboard/projects/actions';
import type { ProjectAccess } from '@/lib/cloud/workspaces';

export function ProjectSwitcher({ projects, currentProjectId }: { projects: ProjectAccess[]; currentProjectId: string }) {
  const organizationIds = [...new Set(projects.map(project => project.organizationId))];
  const current = projects.find(project => project.id === currentProjectId);
  return (
    <div className="project-switcher">
      <form action={selectProjectAction}>
        <label htmlFor="active-project">{current?.organizationName} / project</label>
        <div className="project-switcher-controls">
          <select id="active-project" name="projectId" aria-label="Organization / project" defaultValue={currentProjectId}>
            {organizationIds.map(id => <optgroup key={id} label={projects.find(project => project.organizationId === id)!.organizationName}>
              {projects.filter(project => project.organizationId === id).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </optgroup>)}
          </select>
          <button className="button secondary small" type="submit">Open</button>
        </div>
      </form>
      <Link href="/dashboard/projects" prefetch={false}>Manage projects</Link>
    </div>
  );
}

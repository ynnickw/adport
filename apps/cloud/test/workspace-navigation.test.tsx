import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ProjectManager } from '@/components/project-manager';
import type { ProjectAccess } from '@/lib/cloud/workspaces';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/app/dashboard/projects/actions', () => ({ selectProjectAction: vi.fn(), createProjectAction: vi.fn(), createOrganizationAction: vi.fn(), updateProjectAction: vi.fn() }));

function project(role: ProjectAccess['organizationRole']): ProjectAccess {
  return { id: 'project', name: 'Product marketing', organizationId: 'company', organizationName: 'Acme', role, organizationRole: role, defaultProjectId: 'project', archivedAt: null };
}

describe('workspace navigation permissions', () => {
  it.each(['owner', 'admin'] as const)('exposes project and organization management to an %s', role => {
    const html = renderToStaticMarkup(<ProjectSwitcher projects={[project(role)]} currentProjectId="project" />);
    expect(html).toContain('New project');
    expect(html).toContain('Manage projects');
    expect(html).toContain('Organization settings');
  });

  it.each(['member', 'viewer'] as const)('lets a %s browse assigned projects without management controls', role => {
    const projects = [project(role)];
    const switcher = renderToStaticMarkup(<ProjectSwitcher projects={projects} currentProjectId="project" />);
    expect(switcher).toContain('View projects');
    expect(switcher).not.toContain('New project');
    expect(switcher).not.toContain('Organization settings');
    const directory = renderToStaticMarkup(<ProjectManager projects={projects} currentProjectId="project" defaultProjectId="project" organizationName="Acme" canManage={false} />);
    expect(directory).toContain('Product marketing');
    expect(directory).not.toContain('Settings for ');
    expect(directory).not.toContain('>Archived');
  });
});

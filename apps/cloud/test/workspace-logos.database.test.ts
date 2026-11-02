import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, closeDbForTests } from '@/lib/db';
import { createOrganization, createProject, listProjectAccess, listOrganizationProjects, saveOrganizationMember, updateProject } from '@/lib/cloud/workspaces';
import { readWorkspaceLogo, updateWorkspaceLogo } from '@/lib/cloud/workspace-logos';
import { resolveMembership } from '@/lib/cloud/repository';
const mocks = vi.hoisted(() => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.sessionPrincipal }));
import { POST as deleteProject } from '@/app/api/deletion/route';

const describeDatabase = process.env.ADPORT_RUN_DATABASE_TESTS === '1' ? describe : describe.skip;
describeDatabase('private workspace logos', () => {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const users: string[] = [];
  let owner: string;
  let viewer: string;
  let outsider: string;
  let company: string;
  let project: string;
  let sibling: string;
  let file: File;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname)) throw new Error('Logo integration tests require local Supabase.');
    for (const label of ['owner', 'viewer', 'outsider']) {
      const created = await admin.auth.admin.createUser({ email: `logo-${label}-${randomUUID()}@example.test`, password: 'Local-Logo-Test-Passw0rd!', email_confirm: true });
      if (created.error || !created.data.user) throw created.error ?? new Error('User creation failed');
      users.push(created.data.user.id);
    }
    [owner, viewer, outsider] = users as [string, string, string];
    company = (await resolveMembership(owner)).organizationId;
    await db()`update public.organization_subscriptions set plan = 'agency', status = 'active' where organization_id = ${company}`;
    project = await createProject(owner, company, 'Logo project');
    sibling = await createProject(owner, company, 'Private sibling');
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [project] });
    const image = await sharp({ create: { width: 80, height: 40, channels: 4, background: '#ff660080' } }).png().toBuffer();
    file = new File([new Uint8Array(image)], 'logo.png', { type: 'image/png' });
  });

  afterAll(async () => {
    if (project) await updateWorkspaceLogo(owner, 'project', project, null);
    if (company) await updateWorkspaceLogo(owner, 'organization', company, null);
    if (users.length) {
      await db()`delete from public.organizations where created_by in ${db()(users)} and id <> organization_group_id`;
      await db()`delete from public.organizations where created_by in ${db()(users)}`;
      for (const user of users) await admin.auth.admin.deleteUser(user);
    }
    await closeDbForTests();
  });

  it('keeps project and organization logos distinct and exposes their paths to dashboard readers', async () => {
    const projectPath = await updateWorkspaceLogo(owner, 'project', project, file);
    const companyPath = await updateWorkspaceLogo(owner, 'organization', company, file);
    expect(projectPath).toMatch(new RegExp(`^project/${project}/.*\\.png$`));
    expect(companyPath).toMatch(new RegExp(`^organization/${company}/.*\\.png$`));
    const access = (await listProjectAccess(viewer)).find(row => row.id === project)!;
    expect(access).toMatchObject({ logoPath: projectPath, organizationLogoPath: companyPath });
    expect((await listOrganizationProjects(owner, company)).find(row => row.id === project)?.logoPath).toBe(projectPath);
    expect((await readWorkspaceLogo(viewer, 'project', project)).type).toContain('image/png');
    expect((await readWorkspaceLogo(viewer, 'organization', company)).size).toBeGreaterThan(0);
    const anonymous = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    expect((await anonymous.storage.from('workspace-logos').download(projectPath!)).error).not.toBeNull();
    const bucket = await admin.storage.getBucket('workspace-logos');
    expect(bucket.data?.public).toBe(false);
  });

  it('rejects member/viewer edits and cross-project or cross-organization reads', async () => {
    await expect(updateWorkspaceLogo(viewer, 'project', project, file)).rejects.toMatchObject({ status: 403 });
    await expect(updateWorkspaceLogo(viewer, 'organization', company, null)).rejects.toMatchObject({ status: 403 });
    await expect(readWorkspaceLogo(viewer, 'project', sibling)).rejects.toMatchObject({ status: 404 });
    await expect(readWorkspaceLogo(outsider, 'organization', company)).rejects.toMatchObject({ status: 404 });
    await expect(updateWorkspaceLogo(outsider, 'project', project, file)).rejects.toMatchObject({ status: 404 });
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'member', projectIds: [project] });
    await expect(updateWorkspaceLogo(viewer, 'project', project, null)).rejects.toMatchObject({ status: 403 });
  });

  it('allows admins to replace and remove logos, deleting superseded objects and auditing changes', async () => {
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'admin', projectIds: [] });
    const old = (await listProjectAccess(owner)).find(row => row.id === project)!.logoPath!;
    const path = await updateWorkspaceLogo(viewer, 'project', project, file);
    expect((await admin.storage.from('workspace-logos').download(old)).error).not.toBeNull();
    expect((await admin.storage.from('workspace-logos').download(path!)).error).toBeNull();
    await updateWorkspaceLogo(viewer, 'project', project, null);
    expect((await admin.storage.from('workspace-logos').download(path!)).error).not.toBeNull();
    await expect(readWorkspaceLogo(owner, 'project', project)).rejects.toMatchObject({ status: 404 });
    const events = await db()<Array<{ summary: string }>>`select summary from public.audit_events where organization_id = ${project} and tool = 'project_logo_update' and actor_user_id = ${viewer}`;
    expect(events.map(row => row.summary)).toEqual(expect.arrayContaining(['Updated project logo', 'Removed project logo']));
  });

  it('serializes concurrent replacements and denies revoked and archived project access', async () => {
    await Promise.all([updateWorkspaceLogo(owner, 'project', project, file), updateWorkspaceLogo(owner, 'project', project, file)]);
    const stored = await admin.storage.from('workspace-logos').list(`project/${project}`);
    expect(stored.data).toHaveLength(1);
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [project] });
    await updateProject(owner, project, { archived: true });
    await expect(readWorkspaceLogo(viewer, 'project', project)).rejects.toMatchObject({ status: 404 });
    expect((await readWorkspaceLogo(owner, 'project', project)).size).toBeGreaterThan(0);
    await updateProject(owner, project, { archived: false });
    await saveOrganizationMember({ actorUserId: owner, organizationId: company, userId: viewer, role: 'viewer', projectIds: [sibling] });
    await expect(readWorkspaceLogo(viewer, 'project', project)).rejects.toMatchObject({ status: 404 });
  });

  it('cleans up only the deleted project logo, then both logos when deleting a default project', async () => {
    const child = await createProject(owner, company, 'Deletion logo fixture');
    const childPath = await updateWorkspaceLogo(owner, 'project', child, file);
    const organizationPath = (await listProjectAccess(owner)).find(row => row.id === project)!.organizationLogoPath!;
    mocks.sessionPrincipal.mockResolvedValue({ organizationId: child, userId: owner, role: 'owner', scopes: [] });
    const request = (id: string) => new Request('http://localhost/api/deletion', { method: 'POST', body: JSON.stringify({ organization_id: id, confirmation: 'DELETE' }) });
    expect((await deleteProject(request(child))).status).toBe(200);
    expect((await admin.storage.from('workspace-logos').download(childPath!)).error).not.toBeNull();
    expect((await admin.storage.from('workspace-logos').download(organizationPath)).error).toBeNull();

    const disposable = await createOrganization(owner, 'Deletion organization fixture');
    const projectPath = await updateWorkspaceLogo(owner, 'project', disposable, file);
    const companyPath = await updateWorkspaceLogo(owner, 'organization', disposable, file);
    mocks.sessionPrincipal.mockResolvedValue({ organizationId: disposable, userId: owner, role: 'owner', scopes: [] });
    expect((await deleteProject(request(disposable))).status).toBe(200);
    for (const path of [projectPath, companyPath]) expect((await admin.storage.from('workspace-logos').download(path!)).error).not.toBeNull();
  });
});

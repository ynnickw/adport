import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { ProjectMediaLibrary, MAX_MEDIA_BYTES, MEDIA_TYPES } from '@/lib/cloud/media';
import { env } from '@/lib/env';
import { listConnections } from '@/lib/cloud/repository';
import { MEDIA_PLATFORMS } from '@adport/core/media-platforms';
import { AssetLibrary } from './asset-library';
import { LIBRARY_PAGE_SIZE } from './library-constants';

export const metadata = { title: 'Creative library' };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ project_id?: string }> }) {
  const [tenant, params] = await Promise.all([requireDashboardTenant(), searchParams]);
  const project = tenant.projects.find(project => project.id === (params.project_id ?? tenant.organizationId));
  if (!project) notFound();
  const principal = await sessionPrincipal(project.id);
  const [result, connections] = await Promise.all([
    new ProjectMediaLibrary(principal).list({ limit: LIBRARY_PAGE_SIZE }),
    listConnections(project.id, tenant.userId),
  ]);
  const connectedPlatforms = MEDIA_PLATFORMS.filter(platform => connections.some(connection => connection.provider === platform && connection.status === 'connected'));
  return <main className="page">
    <PageHeader title={`Creative library · ${project.name}`} description="Upload files here. Manage your creatives through your assistant." />
    <AssetLibrary key={project.id} projectId={project.id} projectName={project.name} connectedPlatforms={connectedPlatforms} initialAssets={result.assets} truncated={result.truncated} initialCursor={result.next_cursor}
      canUpload={principal.scopes.includes('tools:write')} maxBytes={MAX_MEDIA_BYTES} acceptedTypes={[...MEDIA_TYPES]} storageOrigin={new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin} />
  </main>;
}

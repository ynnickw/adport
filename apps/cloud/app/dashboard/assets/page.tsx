import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/ui';
import { requireDashboardTenant } from '@/lib/cloud/dashboard';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { ProjectMediaLibrary, MAX_MEDIA_BYTES, MEDIA_TYPES } from '@/lib/cloud/media';
import { env } from '@/lib/env';
import { AssetLibrary } from './asset-library';

export const metadata = { title: 'Creative media' };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ project_id?: string }> }) {
  const [tenant, params] = await Promise.all([requireDashboardTenant(), searchParams]);
  const project = tenant.projects.find(project => project.id === (params.project_id ?? tenant.organizationId));
  if (!project) notFound();
  const principal = await sessionPrincipal(project.id);
  const result = await new ProjectMediaLibrary(principal).list({ limit: 100 });
  return <main className="page">
    <PageHeader title={`Creative media · ${project.name}`} description="Upload private images, video and audio for your ads. Your assistant can find these files in the media library." showDescription />
    <AssetLibrary key={project.id} projectId={project.id} projectName={project.name} initialAssets={result.assets} truncated={result.truncated}
      canUpload={principal.scopes.includes('tools:write')} maxBytes={MAX_MEDIA_BYTES} acceptedTypes={[...MEDIA_TYPES]} storageOrigin={new URL(env().NEXT_PUBLIC_SUPABASE_URL).origin} />
  </main>;
}

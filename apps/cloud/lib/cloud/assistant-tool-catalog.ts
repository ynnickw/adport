import 'server-only';
import { hostedToolCatalogCounts } from './runtime';
import { listMcpOAuthGrants, listMcpProjects } from './mcp-oauth-repository';
import { CLOUD_PROVIDERS } from './types';

export async function listAssistantGrants(organizationId: string, userId?: string) {
  const grants = await listMcpOAuthGrants(organizationId, userId);
  const catalogs = new Map<string, ReturnType<typeof loadCatalog>>();
  async function loadCatalog(groupIds?: string[]) {
    const projects = await listMcpProjects({ userId, organizationId, oauthOrganizationGroupIds: groupIds });
    const connected = new Set(projects.flatMap(project => project.providers));
    return {
      catalogCounts: hostedToolCatalogCounts(projects.map(project => project.id)),
      suggestedProviders: CLOUD_PROVIDERS.filter(provider => connected.has(provider)),
    };
  }
  return Promise.all(grants.map(async ({ organizationGroupIds, ...grant }) => {
    if (!userId || grant.userId !== userId || grant.status !== 'active') return grant;
    const groupIds = organizationGroupIds ?? (grant.organizationGroupId ? [grant.organizationGroupId] : undefined);
    const key = groupIds?.join(',') ?? '';
    let catalog = catalogs.get(key);
    if (!catalog) {
      catalog = loadCatalog(groupIds);
      catalogs.set(key, catalog);
    }
    return { ...grant, ...await catalog };
  }));
}

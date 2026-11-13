import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AssetsPage from '@/app/dashboard/assets/page';

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), session: vi.fn(), list: vi.fn(), connections: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));
vi.mock('@/lib/cloud/dashboard', () => ({ requireDashboardTenant: mocks.tenant }));
vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: mocks.session }));
vi.mock('@/lib/cloud/repository', () => ({ listConnections: mocks.connections }));
vi.mock('@/lib/cloud/media', () => ({ ProjectMediaLibrary: class { list = mocks.list; }, MAX_MEDIA_BYTES: 50_000_000, MEDIA_TYPES: ['image/png'] }));
vi.mock('@/lib/env', () => ({ env: () => ({ NEXT_PUBLIC_SUPABASE_URL: 'https://qa.supabase.co' }) }));
vi.mock('@/components/ui', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/app/dashboard/assets/asset-library', () => ({ AssetLibrary: ({ connectedPlatforms }: { connectedPlatforms: string[] }) => <div data-platforms={connectedPlatforms.join(',')} /> }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenant.mockResolvedValue({ organizationId: 'project-one', userId: 'member', projects: [{ id: 'project-one', name: 'One' }, { id: 'project-two', name: 'Two' }] });
  mocks.session.mockResolvedValue({ scopes: ['tools:write'] });
  mocks.list.mockResolvedValue({ assets: [], truncated: false });
});

describe('creative library platform choices', () => {
  it('uses only healthy connections from the requested authorized project, deduplicated in provider order', async () => {
    mocks.connections.mockImplementation(async (project: string) => project === 'project-two'
      ? [{ provider: 'apple', status: 'connected' }, { provider: 'meta', status: 'connected' }, { provider: 'meta', status: 'connected' }, { provider: 'google', status: 'error' }, { provider: 'x', status: 'revoked' }, { provider: 'demo', status: 'connected' }]
      : [{ provider: 'pinterest', status: 'connected' }]);
    const html = renderToStaticMarkup(await AssetsPage({ searchParams: Promise.resolve({ project_id: 'project-two' }) }));
    expect(mocks.session).toHaveBeenCalledWith('project-two'); expect(mocks.connections).toHaveBeenCalledExactlyOnceWith('project-two', 'member');
    expect(html).toContain('data-platforms="meta,apple"'); expect(html).not.toContain('pinterest'); expect(html).not.toContain('google');
  });

  it('rejects an unauthorized project before reading its connections or media', async () => {
    await expect(AssetsPage({ searchParams: Promise.resolve({ project_id: 'another-project' }) })).rejects.toThrow('not found');
    expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.connections).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled();
  });
});

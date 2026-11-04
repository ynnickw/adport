import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listMcpProjects } from '@/lib/cloud/mcp-oauth-repository';

const mocks = vi.hoisted(() => ({ query: vi.fn(), logos: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: () => mocks.query }));
vi.mock('@/lib/cloud/mcp-project-logos', () => ({ mcpProjectLogoUrls: mocks.logos }));
const id = 'ccd3710c-594a-4c31-8cc0-3f0317213154';
const path = `project/${id}/0350a0a1-567d-427e-a479-c3a385cd3da6.png`;
const principal = { organizationId: id, userId: 'authorized-user', scopes: ['tools:read'] };
beforeEach(() => { vi.clearAllMocks(); mocks.query.mockResolvedValue([{ id, name: 'Product', organizationName: 'Company', role: 'viewer', providers: ['google'], logoPath: path }]); });

describe('MCP project directory metadata', () => {
  it('adds logo previews to the directory without returning private object paths', async () => {
    mocks.logos.mockResolvedValue(new Map([[path, 'https://example.test/signed-logo.png']]));
    const rows = await listMcpProjects(principal, true);
    expect(rows).toEqual([{ id, name: 'Product', organization_name: 'Company', role: 'viewer', providers: ['google'], logo_url: 'https://example.test/signed-logo.png' }]);
    expect(mocks.query.mock.calls[0]?.slice(1)).toEqual(['authorized-user', null, id, null]);
    expect(mocks.logos).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id, logoPath: path })]));
  });
  it('does not make Storage calls while resolving ordinary tools or without a user', async () => {
    expect((await listMcpProjects(principal))[0]).not.toHaveProperty('logoPath');
    expect(mocks.logos).not.toHaveBeenCalled();
    vi.clearAllMocks();
    expect(await listMcpProjects({ organizationId: id, scopes: [] }, true)).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.logos).not.toHaveBeenCalled();
  });
});

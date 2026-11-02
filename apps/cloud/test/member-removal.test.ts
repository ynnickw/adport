import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE } from '@/app/api/members/route';
import { sessionPrincipal } from '@/lib/cloud/auth';
import { removeOrganizationMember } from '@/lib/cloud/tenant-admin';

vi.mock('@/lib/cloud/auth', () => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/lib/cloud/tenant-admin', () => ({
  changeOrganizationMemberRole: vi.fn(), inviteOrganizationMember: vi.fn(),
  listOrganizationMembers: vi.fn(), removeOrganizationMember: vi.fn(),
}));

const organizationId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const principal = { organizationId, userId: 'owner', role: 'owner' as const, scopes: [] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sessionPrincipal).mockResolvedValue(principal);
  vi.mocked(removeOrganizationMember).mockResolvedValue(undefined);
});

describe('project member removal', () => {
  it('accepts the JSON request sent by the project team controls', async () => {
    const response = await DELETE(new Request('https://app.adport.test/api/members', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, userId }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
    expect(sessionPrincipal).toHaveBeenCalledWith(organizationId);
    expect(removeOrganizationMember).toHaveBeenCalledWith(principal, userId);
  });

  it('preserves the existing query-parameter request', async () => {
    const response = await DELETE(new Request(`https://app.adport.test/api/members?organization_id=${organizationId}&user_id=${userId}`, { method: 'DELETE' }));
    expect(response.status).toBe(200);
    expect(removeOrganizationMember).toHaveBeenCalledWith(principal, userId);
  });

  it('rejects an invalid target before resolving access or removing anyone', async () => {
    const response = await DELETE(new Request('https://app.adport.test/api/members', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, userId: 'invalid' }),
    }));
    expect(response.status).toBe(403);
    expect(sessionPrincipal).not.toHaveBeenCalled();
    expect(removeOrganizationMember).not.toHaveBeenCalled();
  });

  it('requires current membership in the requested project', async () => {
    vi.mocked(sessionPrincipal).mockRejectedValue(new Error('You do not have access to this organization.'));
    const response = await DELETE(new Request('https://app.adport.test/api/members', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, userId }),
    }));
    expect(response.status).toBe(403);
    expect(removeOrganizationMember).not.toHaveBeenCalled();
  });

  it('preserves the server-side restriction on inherited organization roles', async () => {
    vi.mocked(removeOrganizationMember).mockRejectedValue(new Error('Manage organization owners and admins in Organization settings.'));
    const response = await DELETE(new Request('https://app.adport.test/api/members', {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, userId }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Manage organization owners and admins in Organization settings.' });
  });
});

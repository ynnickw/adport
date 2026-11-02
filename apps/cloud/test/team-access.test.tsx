import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TeamMembers } from '@/app/dashboard/team/team-members';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const members = [
  { userId: 'owner', email: 'owner@example.test', displayName: 'Company owner', role: 'owner', inheritedFromOrganization: true },
  { userId: 'admin', email: 'admin@example.test', displayName: 'Company admin', role: 'admin', inheritedFromOrganization: true },
  { userId: 'member', email: 'member@example.test', displayName: 'Growth teammate', role: 'member', inheritedFromOrganization: false },
];

describe('company project team controls', () => {
  it('keeps inherited organization roles visible but not editable from a project', () => {
    const html = renderToStaticMarkup(<TeamMembers organizationId="project" currentUserId="owner" currentRole="owner" members={members} />);
    expect(html).toContain('Organization admin · all projects');
    expect(html).not.toContain('Role for admin@example.test');
    expect(html).not.toContain('Role for owner@example.test');
    expect(html).toContain('Role for member@example.test');
    expect(html.match(/>Remove<\/button>/g)).toHaveLength(1);
  });

  it.each(['member', 'viewer'])('gives a %s no invitation, role-change, or removal controls', role => {
    const html = renderToStaticMarkup(<TeamMembers organizationId="project" currentUserId={role} currentRole={role} members={members} />);
    expect(html).not.toContain('Role for ');
    expect(html).not.toContain('>Invite</button>');
    expect(html).not.toContain('>Remove</button>');
    expect(html).toContain('Company admin');
  });
});

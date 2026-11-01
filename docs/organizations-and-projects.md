# Organizations and projects

An organization represents a company or agency and owns its subscription and
team. A project represents a client or brand. Connections, encrypted grants,
selected advertising accounts, policies, approvals, findings and audit events
are isolated by project. Organization account and member allowances are shared
across projects; creating a project does not create another paid allowance.

Owners and admins inherit access to every project. Owners alone manage billing
and organization owners/admins. Other members and client viewers receive only
explicitly selected projects. Removing an organization member removes their
project grants and revokes their MCP OAuth tokens. The last owner cannot be
removed or demoted. Archived projects reject agent access and release their
active account selections; restoring a project requires selecting accounts again.

New-user invitation emails return through the existing `/auth/callback` URL
to `/auth/invite`. That page accepts Supabase's default implicit invitation
session, immediately clears the credentials from the URL fragment, verifies the
user, and lets them set a password before opening their assigned project. The
server rechecks project membership before saving the project selection. Keep
the callback and its `return_to` query variations in the Supabase Auth redirect
allowlist. This uses the existing approved callback rather than adding a new
advertising-platform or MCP OAuth redirect URI.

The default project cannot be archived. Existing permanent deletion remains
available for individual projects; a default project cannot be deleted while
other projects remain. Archiving client projects preserves their audit evidence.

## Compatibility

The existing `public.organizations` rows remain the project tenancy boundary.
The company-level records are `public.organization_groups`, with company roles
in `public.organization_group_memberships`. The internal legacy
`TenantPrincipal.organizationId` and existing HTTP `organizationId` parameters
continue to identify a project. This avoids rewriting encrypted credential AAD,
foreign keys, pending-operation hashes, API keys or OAuth grants.

The migration creates one company for each existing tenant and retains its
original ID as the default project and billing anchor. Projects added to a
company inherit that anchor's subscription. No provider tool names, input
schemas, annotations, UI resources, endpoint URLs, OAuth discovery URLs, or
client registrations change.

The dashboard project selector is an HTTP-only preference, checked against
current membership on every request. It cannot retarget an MCP or API-key
connection. OAuth consent explicitly chooses one project; the issued grant
remains bound to that project. To use a different project, authorize a separate
connection if the client supports it, or reconnect and choose the project.
Provider authorization callbacks retain their initiating project even if the
dashboard selection changes in another tab.

## Release validation

Apply `20261031144325_agency_organizations_and_projects.sql` to staging before
running the new application. Deploy application and schema as one coordinated
release. Do not run the new application against the old schema. The migration
is additive and leaves existing credentials and MCP grants valid; reverting the
application after users create additional projects would hide those projects
from older dashboard code, so retain the new schema and data during rollback.

Run build, tests, typecheck, local database advisors, and HTTP integration tests.
Exercise tenant RLS, organization-wide account and member caps, concurrent
activation, project archival, owner protection, subscription cancellation and
OAuth membership revocation. Test project creation, switching, client access
and consent in the browser, including a fresh invitation through the local
mailbox and password setup. Before release, repeat the submitted Claude/Codex
reviewer workflows against staging and confirm the MCP catalog is unchanged.

Keeping contracts stable preserves technical compatibility; directory approval
remains controlled by each platform. Do not replace or resubmit a directory
listing automatically as part of this feature.

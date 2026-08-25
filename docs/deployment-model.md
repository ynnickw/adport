# Deployment model

Adport has one shared provider/tool/policy layer and two deployment modes. The self-hosted CLI remains local and bring-your-own-credentials. The managed cloud application is implemented in `apps/cloud` and is currently intended to be run and verified locally before a production deployment.

## Self-hosted mode

- The operator runs the CLI and stdio MCP server on infrastructure they control.
- Provider credentials remain in `${ADPORT_HOME:-~/.config/adport}/credentials.json` with file mode `0600`.
- Provider calls go directly from that installation to the advertising platform.
- Pending operations and audit JSONL files remain local.
- No Adport Cloud account, Supabase project, hosted OAuth callback, or remote MCP endpoint is involved.

## Cloud mode

The cloud application is a Next.js 16 service backed by Supabase Auth and Postgres.

1. Supabase Auth establishes the user session.
2. Every request resolves an organization membership and role on the server.
3. Browser reads use explicit RLS policies and least-privilege PostgREST grants.
4. Transactional server work uses the restricted `adport_backend` database role. It cannot read the Auth schema directly; narrowly scoped security-definer functions provide member lookup.
5. Provider credentials are encrypted with AES-256-GCM using tenant/provider-bound additional authenticated data. OAuth state is hashed, one-time, PKCE-bound, and expires after 10 minutes.
6. A tenant runtime decrypts only that organization's connected providers and constructs the existing provider modules.
7. REST and remote MCP call the same `ToolRegistry` and `PolicyEngine` as the CLI. There is no cloud-only mutation path.
8. Pending approvals and audit events are persisted in Postgres. The exact operation hash, tenant, provider, expiry, and policy are checked again before apply.

The cloud runtime supports Google, Meta, TikTok, Apple, Microsoft, and Reddit providers. Every provider is connected through the hosted browser-based OAuth broker (`/api/oauth/<provider>/start` → provider consent → `/api/oauth/<provider>/callback`) using Adport-owned applications configured in server environment; Google requests only `https://www.googleapis.com/auth/adwords`. Tenants never enter application secrets, and each provider card is disabled until its application is approved and configured. Apple Ads uses Adport's approved service-provider authorization-code flow with the `searchads` scope; the shared ES256 client key remains server-side and only each tenant's encrypted refresh token is stored in the vault. Microsoft and Reddit refresh-token rotations are persisted immediately; disconnect revokes the grant at the provider where an API exists before deleting the encrypted copy.

## Tenant and service controls

- Personal organizations are created by an Auth trigger; memberships use owner, admin, member, and viewer roles.
- Owners and admins can invite members. Only owners can grant admin access, and the final owner cannot be removed or demoted.
- Hosted MCP uses OAuth 2.1 discovery, dynamic client registration, S256 PKCE, explicit workspace consent, audience-bound one-hour access tokens, and rotating refresh tokens. Manual API keys remain available for REST and legacy MCP clients; only a keyed digest and prefix are stored. Tool discovery is filtered by the grant's read/write scopes.
- Requests are rate-limited by a keyed subject hash.
- Provider secrets, encryption keys, Supabase administrative keys, and OAuth client secrets are server-only.
- Google disconnect revokes at Google before deleting the local encrypted refresh token. If revocation fails, the token remains available for retry.
- Manual-provider disconnect removes the encrypted copy and explicitly tells the user that provider-side revocation is still required.
- Safety settings and member changes commit atomically with their audit event.
- Audit, pending-operation, OAuth-transaction, and rate-limit retention is enforced by a scheduled Postgres job.
- Organization deletion cascades through tenant data and deletes the Auth user when no memberships remain.

## Local cryptography and production key management

Local development reads a 256-bit master key from `ADPORT_CLOUD_ENCRYPTION_KEY`. This keeps the local stack reproducible but is not the intended production key-delivery mechanism.

Before production, provide that value through a managed secret/KMS boundary, restrict decrypt permission to the cloud runtime identity, define rotation and recovery procedures, and record the key version stored with each ciphertext. A production database login should inherit only `adport_backend`; do not run application queries as a database owner. Use TLS for browser, API, database, and provider traffic.

## Production gates

The local implementation is not itself authorization to launch publicly. A production rollout still requires:

- a hosted Supabase project and dedicated backend database login;
- managed secrets/KMS, backup policy, monitoring, alerting, and incident response;
- exact production domains, OAuth redirect URIs, CSP and edge rate limits;
- reviewed/approved provider applications and production developer access;
- the published privacy policy, terms, deletion path, and subprocessor records;
- Google OAuth verification evidence: exact scope match, public/unlisted end-to-end video, reviewer credentials, clear navigation instructions, and source-account proof for demonstrated writes/removals;
- a staging project for unverified OAuth changes so production users are not exposed to unverified scopes; and
- restore, revocation, retention, tenant-isolation, and operational runbooks tested before launch.

Apple Ads Cloud uses interactive delegated OAuth through Adport's approved service-provider registration. The application signs its client secret with a server-side ES256 private key, exchanges the returned authorization code for a tenant refresh token, and mints one-hour bearer tokens without exposing application key material to tenants. The local CLI continues to support Apple's self-managed API-user client-credentials flow.

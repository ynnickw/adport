# Adport Cloud architecture

Status: experimental local milestone. Application code in `apps/` is AGPL-3.0-only; reusable packages remain Apache-2.0.

## Product contract

Adport Cloud is another adapter around the existing `ToolRegistry`. Dashboard and future remote MCP reads use the same normalized tools as the CLI. Writes must continue through `guardedWriteTool` and the shared `PolicyEngine`; the cloud app must never call a provider mutation directly.

```text
Dashboard / remote MCP
        -> authenticated workspace runtime
        -> shared ToolRegistry
        -> shared PolicyEngine
        -> provider module
        -> workspace audit repository
```

## Applications and deployments

- `website/` serves `adport.dev` as a separate, static Vercel project.
- `apps/cloud` serves `app.adport.dev`: identity, workspaces, dashboard, provider callbacks, and initially the API surface.
- A worker is added only when scheduled reports, token maintenance, or queued writes require execution outside a request.
- A remote MCP deployment is extracted only when its scaling or security boundary materially differs from the cloud app.

## Tenant and authority model

Every server-side operation resolves a user, membership, and workspace before accessing data. Provider connections, account allowlists, policies, pending operations, findings, and audit events are workspace-scoped. Provider credentials are encrypted with AES-256-GCM and the workspace id is authenticated as additional data.

Local development uses a SQLite adapter and an explicitly development-only signed session. Production must fail closed without an external identity provider, a managed transactional database, and a 32-byte encryption key. The SQLite adapter is not a production persistence option on serverless hosting.

## Threat model and controls

- Cross-tenant reads and IDOR: the authenticated membership resolves the workspace; repository adapters bind every credential, account, policy, pending operation, finding, and audit query to that workspace.
- Credential disclosure: tokens are encrypted with AES-256-GCM and workspace-bound additional authenticated data. Platform app secrets remain process-level server secrets and are never copied into workspace records or browser responses.
- OAuth login CSRF and callback swapping: provider callbacks require a short-lived, signed state value bound to both user and workspace, plus an HttpOnly SameSite cookie containing the exact state.
- Confused-deputy writes: dashboards and future APIs call the shared registry. Every mutation continues through `guardedWriteTool`, preview/apply argument hashing, expiry, policy checks, and workspace audit logging.
- Excess account authority: discovery results become an explicit workspace allowlist; reporting only requests allowlisted account ids.
- Token or pending-operation replay: OAuth state expires after ten minutes and pending mutations retain the core fifteen-minute TTL and identical-argument hash requirement.
- Local-development escape hatches: signed local auth, SQLite, and credential import are disabled or rejected in production. Production launch additionally requires provider review, managed persistence, key rotation, monitoring, deletion/export paths, and incident runbooks.

## First milestone acceptance criteria

1. A user can sign in locally and receives a default workspace.
2. A provider connection is stored per workspace; secrets are encrypted at rest. The Meta broker start/callback boundary is implemented and state-bound, while public use remains gated on Meta app review.
3. An account allowlist bounds report access.
4. Accounts and normalized reports execute through the shared registry.
5. Overview, Connections, Accounts, Reports, Findings, Approvals, Audit, and Policies have functional server-rendered routes.
6. Findings and audit state use workspace repositories.
7. Local build, typecheck, tests, and browser-to-data verification pass.

## Deferred before a public cloud beta

- Managed Postgres implementation and row-level tenant controls.
- Provider review and production credentials; extend the implemented Meta broker flow to each additional provider.
- Durable queues, retries, refresh-token maintenance, and kill switches.
- OAuth 2.1 remote MCP with Protected Resource Metadata and audience-bound tokens.
- Billing, data export/deletion, incident response, and operational monitoring.

# Adport Cloud local development

## Prerequisites

- Node.js 22.13 or newer
- pnpm
- Docker Desktop or another Docker-compatible runtime
- Supabase CLI 2.114 or newer

## Start from a clean database

```sh
pnpm install
supabase start
supabase db reset --local --yes
```

The repository uses ports in the `553xx` range so it does not collide with the default Supabase ports. Copy `apps/cloud/.env.example` to `apps/cloud/.env.local`, then obtain the local publishable and secret keys from `supabase status`. Never commit `.env.local`.

Generate independent random development values:

```sh
openssl rand -base64 32
openssl rand -base64 32
```

Use one for `ADPORT_CLOUD_ENCRYPTION_KEY` and the other for `ADPORT_API_KEY_PEPPER`.

Provider connections are OAuth-only wherever the platform offers a third-party grant. The app never asks a tenant for application secrets: each provider block in `.env.example` (`GOOGLE_ADS_*`, `META_*`, `TIKTOK_*`, `MICROSOFT_ADS_*`, `REDDIT_*`) holds the Adport-owned application, and the matching Connections card stays disabled ("Awaiting app approval") until that block is fully set. Apple Ads is the single exception: it has no OAuth grant, so tenants paste an API-user key that is encrypted per organization. Leaving every provider block empty is fine for builds and non-provider tests.

## Run

```sh
pnpm --filter @adport/cloud dev
```

The app root `/` is the sign-in screen (signed-in users are redirected to `/dashboard`); there is no marketing landing page in the cloud app — that lives on adport.dev. The dashboard is a sidebar shell with Overview, Connections, Accounts, Reports, Approvals, Audit log, Policies, Team, and Agent access.

Hosted OAuth callbacks are `${ADPORT_CLOUD_BASE_URL}/api/oauth/<provider>/callback` for `google`, `meta`, `tiktok`, `microsoft`, and `reddit`; the shared start route is `/api/oauth/<provider>/start`. If another process owns port 3000, set `ADPORT_CLOUD_BASE_URL` to the actual port and register the same redirect in each development provider app.

For a production-mode local check:

```sh
pnpm --filter @adport/cloud build:standalone
PORT=3100 HOSTNAME=127.0.0.1 node --env-file=apps/cloud/.env.local apps/cloud/.next/standalone/apps/cloud/server.js
```

## Verification

```sh
pnpm --filter @adport/cloud typecheck
pnpm --filter @adport/cloud test
ADPORT_HTTP_TEST_BASE_URL=http://localhost:3100 pnpm --filter @adport/cloud test
supabase db advisors --local --type security --level info
supabase db advisors --local --type performance --level warn
```

The ordinary test run skips the two live-server cases. Setting `ADPORT_HTTP_TEST_BASE_URL` adds real HTTP authorization, REST, and remote MCP handshake checks.

The database suite verifies:

- Auth-triggered personal tenants and RLS isolation;
- encrypted credentials for all six providers with no plaintext in Postgres;
- hosted OAuth broker consent URLs, PKCE where supported, and application-identity injection for every OAuth provider;
- browser-safe provider error mapping (no echoed tokens or CLI instructions);
- API-key digest authentication and revocation;
- durable preview/apply pending operations and audit events;
- tenant member and safety-setting transactions;
- last-owner protection; and
- scheduled retention deletion.

## Local service URLs

- Cloud app: `http://localhost:3000`
- Supabase API: `http://127.0.0.1:55321`
- Postgres: `postgresql://postgres:postgres@127.0.0.1:55322/postgres`
- Studio: `http://127.0.0.1:55323`
- Local mail viewer: `http://127.0.0.1:55324`

## Secret-handling rules

- Never expose `SUPABASE_SECRET_KEY`, the database URL, provider credentials, OAuth client/app secrets, developer tokens, encryption keys, or API-key peppers through `NEXT_PUBLIC_*`.
- Application identity (client/app id, secret, developer token, user agent) stays in server env; only the tenant grant is written to the encrypted vault, and the runtime injects the application identity when building provider clients.
- Never log request bodies for connection, OAuth, API-key creation, or MCP bearer authentication routes.
- API keys are shown once. Provider credentials are accepted server-side, encrypted, and never returned.
- Use the local stack only with test advertising credentials. Production credentials belong in the deployed secret/KMS and database environment.

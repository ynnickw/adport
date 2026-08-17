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

Use one for `ADPORT_CLOUD_ENCRYPTION_KEY` and the other for `ADPORT_API_KEY_PEPPER`. Local placeholder Google application values are sufficient for builds and non-Google tests; a real Google OAuth flow requires a web OAuth client, developer token, and exact callback URI.

## Run

```sh
pnpm --filter @adport/cloud dev
```

The default callback is `http://localhost:3000/api/oauth/google/callback`. If another process owns port 3000, set `ADPORT_CLOUD_BASE_URL` to the actual port and register the same redirect in the development Google Cloud project.

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

- Never expose `SUPABASE_SECRET_KEY`, the database URL, provider credentials, OAuth client secrets, encryption keys, or API-key peppers through `NEXT_PUBLIC_*`.
- Never log request bodies for connection, OAuth, API-key creation, or MCP bearer authentication routes.
- API keys are shown once. Provider credentials are accepted server-side, encrypted, and never returned.
- Use the local stack only with test advertising credentials. Production credentials belong in the deployed secret/KMS and database environment.

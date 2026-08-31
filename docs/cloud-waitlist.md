# Cloud waitlist

The static landing page submits JSON to `/api/waitlist`. Its Vercel rewrite
forwards requests to `https://app.adport.dev/api/waitlist` in `apps/cloud`.
The endpoint requires an exact Adport origin, explicit early-access consent,
a valid email, an empty honeypot, and a body of at most 2 KiB. It uses the
existing database-backed rate limiter (five requests/client/minute and 100
requests/minute globally). Outside Vercel, requests share a conservative
fallback bucket; another hosting platform needs a trusted client-IP adapter.

Emails are trimmed and lowercased, then inserted into `private.cloud_waitlist`.
The email primary key makes repeat signups idempotent. Both new and existing
addresses receive `{ "ok": true }`; no list or lookup API is exposed. Database
errors never log submitted emails. No invitation email is sent by this endpoint.

The table stores `email`, `created_at`, `consent_version`, and `source`. RLS is
enabled; only `adport_backend` has select/insert policies and grants. Anonymous
and authenticated browser roles have no table access. Deletion requests must
be handled by an authorized database administrator, not a public endpoint.

## Deployment order

1. Apply `20260831140245_cloud_waitlist.sql` to the Adport production database
   through the normal migration process. Do not push unrelated pending migrations.
2. Deploy `apps/cloud` with the existing database and encryption/pepper settings.
   No new secret or frontend database key is required.
3. Deploy `website`, including its `/api/waitlist` rewrite.
4. Verify a consented signup and its stored row on the production deployment.

The landing page retains local npm setup and advertises hosted MCP at
`https://app.adport.dev/mcp`. The five new provider logos refer to implemented
integrations, not guaranteed platform approval or access for every workspace.

## Local checks

```sh
pnpm --filter @adport/cloud exec vitest run test/waitlist.test.ts
pnpm --filter @adport/cloud typecheck
docker exec -i supabase_db_adport psql -U postgres -d postgres -v ON_ERROR_STOP=1 < scripts/check-waitlist.sql
```

For browser testing, serve `website` with the same security headers as
`website/vercel.json` and proxy `/api/waitlist` to the local cloud server.
Use only synthetic addresses under `example.invalid`; do not send test signups
to the production endpoint. The SQL check rolls back all of its fixture data.

# Legacy Cloud waitlist

Before public early access, the landing page collected emails through
`/api/waitlist`. Visitors now use [Cloud signup](https://app.adport.dev/login?mode=signup).
The existing Vercel rewrite forwards legacy requests to `https://app.adport.dev/api/waitlist` in `apps/cloud`.
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

## Local checks

```sh
pnpm --filter @adport/cloud exec vitest run test/waitlist.test.ts
pnpm --filter @adport/cloud typecheck
docker exec -i supabase_db_adport psql -U postgres -d postgres -v ON_ERROR_STOP=1 < apps/cloud/scripts/check-waitlist.sql
```

Test the endpoint against a local Cloud server with synthetic addresses under
`example.invalid`. The SQL check rolls back all of its fixture data.

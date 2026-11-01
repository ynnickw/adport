# Hosted product analytics

Adport Cloud uses explicit, optional server-side PostHog events to improve setup, returning use, agency adoption, and subscription conversion. The CLI, local MCP, and shared provider packages remain telemetry free. There is no browser PostHog SDK, autocapture, analytics cookie, session recording, or advertising-data export.

## Business dashboard

Project: Adport / Default project, **701110**, US Cloud. [Setup, retention & conversion dashboard](https://us.posthog.com/project/701110/dashboard/2285726).

These are candidate measurement definitions, not approved catalog metrics. Validate the setup proxy against returning use before treating it as activation. Do not invent targets before observing a baseline.

| Decision | Definition | Practical limit |
| --- | --- | --- |
| Where should setup improve? | Connection started → verified grant → account enabled → successful report or applied change, within 7 days | Consented users, not all signups. Dashboard use does not require an agent connection. |
| Does agent setup lead to value? | Agent connected → successful report/applied change via MCP within 7 days | Agent family is inferred from the client's declared name. Refreshes are not new connections. |
| Are businesses getting value? | Distinct `organization_key` with successful report or applied change, by Monday-start week, last 8 weeks | Current week is partial. A successful automatic dashboard report can qualify. |
| Do users return? | Weekly recurring retention of successful reports/applied changes over 8 weeks | Recent cohorts are immature; opt-out and delivery failures reduce observed coverage. |
| Do trials convert? | Signed Stripe subscription status `trialing` → `active` within 21 days, last 90 days | Same checkout initiator with current consent and membership. Subscription active is not received revenue or MRR. Older subscriptions without actor metadata are excluded. |
| Which agency features matter? | Project creation by plan; successful tool categories by surface | Creation counts are not the number of currently active client projects. |
| What prevents use? | Provider connection failures by provider/stage; tool failures by reason/surface | Outcome counts are not a cohort failure rate. Provider error text is excluded. |

All dashboard queries filter `environment = production`. Keep previews separate from applied changes. Use `organization_key` event properties for company-level calculations; paid group analytics is not required. Do not sum per-user counts to estimate distinct companies. There is one synthetic `adport_integration_verified` event in `staging` to verify ingestion; it is excluded from the dashboard.

## Event contract

`apps/cloud/lib/analytics-events.ts` is the strict event/property allowlist. PostHog names add the `adport_` prefix. Common properties are HMAC-pseudonymous `organization_key` and `project_key`, effective `plan`, project `role`, `environment`, and `schema_version = 1`. `distinct_id` is a separate HMAC of the authenticated user ID. Domain separation prevents a user/project/company sharing an identifier.

| Event suffix | Trigger / allowed event properties |
| --- | --- |
| `analytics_enabled` | Saved opt-in. Re-enabling can repeat it; it is not signup. |
| `dashboard_viewed` | Explicit safe section enum `page`, after opt-in. No URL/query string. |
| `onboarding_progressed` | Saved `step`, `complete`, optional selected `agent`. Navigation is not agent connection. |
| `provider_connection_started` | Created OAuth transaction; `provider`. |
| `provider_connection_verified` | Grant exchanged, discovery verified, selection staged; `provider`. Account selection and enablement are separate. |
| `provider_connection_failed` | Authenticated callback outcome; `provider`, `stage` (`authorization` or `verification`). Invalid/unauthenticated callbacks are excluded. |
| `account_access_changed` | Saved account-access state; `provider`, `enabled`. Repeated saves can repeat the event. |
| `agent_connected` | Successful authorization-code exchange; `agent` family. |
| `tool_completed` | Cloud root registry call succeeded; `category`, `surface`. Nested tool calls are not counted again. Applied writes require the actual `applied` result, and previews require `pending_validation`. |
| `tool_failed` | Rejection/error or partial provider failure; `category`, `surface`, safe `reason`. |
| `organization_created`, `project_created` | Committed creation; no names or invited identities. |
| `checkout_started` | Stripe returned a Checkout URL; `target_plan`, `interval`. |
| `subscription_status_changed` | Signed Stripe webhook committed a changed status; `subscription_status`, `target_plan`. Stripe event ID is HMACed as `$insert_id`. |

No raw user/org/project IDs, emails, names, ad-account IDs, campaign data, spend/revenue, report rows, tool inputs/results, tokens, IP/browser headers, raw URLs, or provider messages are forwarded. Person profile creation and GeoIP enrichment are disabled. No `$identify`, aliases, person properties, or groups are emitted.

## Consent and delivery

The authenticated dashboard/onboarding asks once, with equally available Allow/Decline choices. Privacy preferences stays available in navigation and on onboarding. The choice is stored in `private.product_analytics_preferences`, version 1, not browser storage. Only `adport_backend` can access this table; browser database roles have no grants. Deleting the Auth user cascades the preference.

The same authenticated user's consent covers hosted OAuth MCP/REST activity across their projects. API keys without a user are excluded. Delivery rechecks current consent, effective project membership, and archive status. Withdrawal stops future delivery, including queued events that have not started sending; it does not erase historical events. Consent and delivery can race with an already in-flight request. Handle historical deletion requests through the PostHog project's deletion workflow after computing the HMAC user ID server-side; never expose the salt.

Events run in Next.js `after()` with a two-second ingestion timeout. Delivery is best effort, with safe status-only warnings and no persistent event queue. Analytics failures cannot fail tool calls, checkout, or OAuth. Metrics are observational, not a financial ledger. PostHog receives the server's network request, not forwarded client IP/browser headers.

## Configuration and release

Production environment variables have been configured on Vercel project `adport-cloud`; they take effect for new deployments. No existing deployment was replaced as part of setting them. Values remain server-only and are never committed. The actual target was verified in the signed-in Adport PostHog organization.

- `POSTHOG_ENABLED=true`
- `POSTHOG_PROJECT_TOKEN`: write-only project token from project 701110
- `POSTHOG_HOST=https://us.i.posthog.com`: exact verified ingestion origin, no fallback
- `POSTHOG_ID_SALT`: independent random secret, at least 32 characters; keep stable for cohort continuity
- `POSTHOG_ENVIRONMENT=production`
- `POSTHOG_EXCLUDED_PROJECT_IDS`: optional comma-separated project or company UUIDs for staff/test exclusions. Provider-test and synthetic-reviewer exclusions also apply.

Missing/invalid config fails closed. Vercel previews may emit only `staging`, production deployments only `production`. Do not put production credentials or database access into a preview to test analytics. Use separate staging/local salts; all test events must use a non-production environment.

Release after the organizations/projects dependency:

1. Apply `20261031144325_agency_organizations_and_projects.sql`, then `20261031153029_cloud_product_analytics_consent.sql` through the normal reviewed migration workflow. Local migrations and private-table grants have been tested.
2. Deploy the matching cloud code and publish the updated privacy policy. Existing MCP URLs, tool names, schemas, and the write policy gate stay unchanged.
3. Check a real consenting staff user's setup, provider, report, and hosted-agent flow. Confirm ingestion and query filters in project 701110, not AppLaunchFlow. Exclude staff workspaces before interpreting business metrics.
4. Verify Decline and withdrawal stop collection, inspect payloads for the allowlist, and confirm production dashboard queries return only production events.
5. Set an appropriate event-retention period in PostHog and document it in the published privacy/subprocessor record. Do not enable session replay or autocapture to fill missing data.

Rollback: set `POSTHOG_ENABLED=false` and redeploy. Keep consent preferences so a disabled period does not cause users to be prompted again. Changing the salt breaks identity continuity; do not rotate casually or attempt to merge historical identities using raw IDs.

Authoritative API contract: [PostHog capture API](https://posthog.com/docs/api/capture#single-event), [anonymous/profile-free events](https://posthog.com/docs/data/anonymous-vs-identified-events).

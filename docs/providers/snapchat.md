# Snapchat Marketing API contract

Implementation target: Ads API v1. Official references reviewed 2026-08-31:

- [Authentication](https://developers.snap.com/marketing-api/Ads-API/authentication): authorization-code OAuth; form-encoded token requests, client credentials in the body; rotating refresh tokens.
- [Organizations](https://developers.snap.com/marketing-api/Ads-API/organizations) and [ad accounts](https://developers.snap.com/marketing-api/Ads-API/ad-accounts): nested per-item response envelopes and account timezone.
- [Campaigns](https://developers.snap.com/marketing-api/Ads-API/campaigns): creation arrays, account ownership, micro-currency budgets, partial JSON Patch updates, and `paging.next_link`.
- [Measurement](https://developers.snap.com/marketing-api/Ads-API/measurement): TOTAL statistics, nested campaign/ad-squad/ad breakdowns, day boundaries in the account timezone, purchase conversion counts and values.

## Local connection

Create a personal OAuth app under Snap Business Manager → Business Details → OAuth Apps. Register `http://127.0.0.1:53684/callback` for the local wizard. Supply the app secret through `SNAPCHAT_CLIENT_SECRET` in your terminal environment, then run `adport connect snapchat`. The wizard verifies account discovery before saving credentials locally with mode 0600. It does not use Adport Cloud. Use `--no-browser` to select the browser/profile yourself.

Non-interactive runtimes accept `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET`, and `SNAPCHAT_REFRESH_TOKEN`. Store-backed credentials persist rotated refresh tokens; environment-only deployments must manage their own token persistence.

## Semantics and safety

- All writes use the shared policy engine. Preview does not call a mutation endpoint and reports `serverValidated: false`; it is not proof of provider acceptance.
- Creation defaults to PAUSED; policy coercion is reported when overriding ACTIVE. Budgets and lifetime caps remain integer micros for policy checks.
- Status/budget changes read and verify the campaign's ad account, then patch only the selected field. No generic mutation tool is exposed.
- Reports use account-local inclusive calendar dates, converting the following midnight to the exclusive end boundary. DST is covered by tests.
- Normalized clicks mean Snap `swipes`; conversions mean attributed purchases, not all conversion events. Purchase values and spend are divided by one million. Attribution is explicitly 28-day swipe / 1-day view.
- Account-level metrics are aggregated from campaign breakdowns because the bare account stats endpoint only supports spend. Ratios are recomputed from summed base metrics. Missing metrics remain absent, not fabricated zeroes.
- Response schemas validate fields used by normalization and ownership checks while allowing additional API fields. Pagination is constrained to the same API origin and resource path, with cycle detection. Mutation requests are never automatically replayed.

## Verification boundary

Wire tests use synthetic identifiers and official response structures. Passing these tests is not a live API verification or evidence of app approval. Cloud OAuth registration, real account reads, and real paused campaign writes must be recorded separately after credentials and authorization are available.

The local wizard also has tests for mode-0600 storage, state-bound loopback,
custom callback reuse, no-browser operation, failure cleanup and preservation
of a working grant. Changing client IDs cannot silently reuse another app's
stored secret. Hosted wiring is described in [cloud onboarding](cloud-onboarding.md).

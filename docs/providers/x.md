# X Ads

The local CLI and MCP runtime include this provider, tested against official
response contracts. Adport's cloud application received Standard Ads API access
on August 31, 2026. Self-hosters still need their own approved application;
app approval is separate from live verification of individual API operations.

## Connect locally

Use your own Ads API-approved developer app. Securely provide `X_CONSUMER_KEY`,
`X_CONSUMER_SECRET`, `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET` in your shell
environment, then run `adport connect x`. Do not put secrets in command arguments,
chat messages or the repository. The command verifies account discovery before
replacing the local grant and stores credentials with mode 0600. It does not use
the Adport Cloud OAuth broker. `adport disconnect x` removes the local copy only.

## Implemented and contract-tested

- Hosted OAuth helpers implement request-token creation, access-token exchange
  and revocation. Temporary tokens require callback confirmation; signatures
  include the registered callback/verifier, with no secrets in URL queries.
  Form-token parsing rejects duplicate/missing fields and oversized bodies;
  failures are sanitized and one-time exchanges are never automatically retried.
  Cloud uses a default-off rollout gate and organization/user-bound single-use
  transactions. See [hosted onboarding](cloud-onboarding.md).
- OAuth 1.0a HMAC-SHA1 via `oauth-1.0a`, Node crypto and cryptographic nonces.
  Four credentials are required: consumer key/secret and user access token/secret.
  Bearer tokens are not a replacement for Ads API user authentication.
- Fixed HTTPS v12 API origin, redirect rejection, 30-second request timeout,
  sanitized errors, no automatic replay of writes, and schema validation.
- Query parameters on GET, POST and PUT are signed exactly as transmitted.
  Spaces are serialized as `%20` because the signing library does not interpret
  form-style `+` as a space when parsing a query URL. Tests independently calculate
  signatures, including Unicode, punctuation, spaces and literal plus signs.
- Cursor-paginated account, funding-instrument, campaign, line-item and
  promoted-tweet discovery. Duplicate entities and cursor cycles fail closed.
- Accounts have no currency field; no currency is invented. Funding instruments
  and campaigns carry the currency. Tweet snowflakes remain strings.
- Campaign-write planner for create, status and existing daily/total budget
  changes. Creation uses `budget_optimization=LINE_ITEM`, explicit paused policy
  coercion and integer account-currency micros. Funding ownership and availability
  are checked before creation. Previews make only reads. Apply responses must
  match the approved fields and preserve untouched budgets and status.
- Six shared tools expose campaign/funding/line-item reads and campaign
  creation/status/budget changes. All three writes use `guardedWriteTool` and
  the shared policy engine's exact preview/apply gate. Integration tests verify
  mismatched pending arguments, budget caps and protected-account rejection.

## Reporting

The implementation follows these current official contracts:

- Native entities: campaign → `CAMPAIGN`, ad group → `LINE_ITEM`, promoted post
  → `PROMOTED_TWEET`. Account-level `ACCOUNT` analytics lack the BILLING group;
  account reports therefore aggregate campaign analytics, rejecting mixed-currency
  totals. Ad reports include promoted posts/accounts and media creatives; IDs
  include the native entity type to avoid collisions between creative namespaces.
- Separate requests for `ALL_ON_TWITTER`, `SPOTLIGHT` and `TREND` to produce full
  placement totals. A single-placement report must not be labeled a full total.
- At most 20 entity IDs per analytics request, with comma-separated IDs/groups.
- `TOTAL` returns `time_series_length: 1`, with `data[].id_data[].segment: null`
  and metric arrays under `metrics`. Null values are zero-equivalent according to
  X's FAQ; missing unsupported fields need separate handling.
- `billed_charge_local_micro` is spend in currency micros. `clicks` includes
  likes and other engagements; `url_clicks` measures link/Website Card clicks.
- Inclusive Adport dates must become an exclusive end boundary. Whole-hour
  timestamps are required; midnight in the account timezone matters for matching
  the Ads Manager reporting day. Explicitly handle DST and timezone changes.
- Synchronous analytics has a 7-day maximum range. Longer-range and historical
  queries use async analytics in at most 30-day chunks. The implementation polls
  exact `id_str` job IDs, validates account/filters/date scope and accepts downloads
  only from the documented HTTPS host and matching job path, without OAuth headers.
  Downloads and decompressed data are bounded to 20 MiB. A bounded polling timeout
  retains the handle so an identical request on the same running client resumes
  the existing job. Restarting the process does not retain that in-memory handle.
- Reports cover spend, impressions, link clicks, CTR, CPC and CPM. Conversion
  counts, conversion value, CPA and ROAS are not normalized yet: the purchase
  object contract and sale-amount units still need official verification. These
  fields remain absent, never fabricated as zero; requests containing only these
  unsupported metrics fail with an explicit explanation.
- Missing fields remain unknown across aggregation; explicitly null scalar
  metrics are zero-equivalent per X's documentation. Duplicate/missing entity rows,
  unexpected segmentation or changed report scope are rejected.
- Reporting dates before an account timezone switch are rejected because its old
  timezone is unavailable. Timezones whose midnight cannot be represented by the
  API's whole-UTC-hour constraint are also rejected, not rounded silently.

## Access and commercial boundary

Ads API approval is separate from general X API access. An active developer app
or a general project tier is not evidence of Ads API approval. After approval,
X instructs developers to regenerate user access tokens. Local users bring their
own approved app credentials; hosted customer onboarding requires a reviewed
multi-user OAuth flow and appropriate provider permission.

No monthly/request access price was confirmed from the public Ads API onboarding
docs. Do not promise free access or apply general X API prices to Ads endpoints.
Ask Ads Support to confirm fees, spend requirements and the proposed SaaS/MCP use.

## Official references inspected 2026-08-31

- [Campaign management reference](https://docs.x.com/x-ads-api/campaign-management/reference)
  ([official source](https://github.com/xdevplatform/docs/blob/main/x-ads-api/campaign-management/reference.mdx))
- [Analytics reference and FAQ](https://docs.x.com/x-ads-api/analytics)
  ([official source](https://github.com/xdevplatform/docs/blob/main/x-ads-api/analytics.mdx))
- [Making authenticated requests](https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests)
- [Creating a signature](https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature)
- [OAuth 1.0 specification, photo-request test vector](https://oauth.net/core/1.0/)
- [Ads API application guide](https://docs.x.com/x-ads-api/getting-started/step-by-step-guide)
- [API versions](https://docs.x.com/x-ads-api/fundamentals/versioning)

Verification: synthetic wire-contract, reporting, download-security, write-plan
and shared policy-gate tests pass, as do local CLI onboarding tests. All package
builds/tests/typechecks and the public-tree check pass. No live API request, ad
mutation, provider application submission or npm release is implied by these tests.

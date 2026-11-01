# Claude connector readiness — 2026-10-31

## Verified

- Reviewer `reviewer-claude@adport.dev` signs in with its existing password; no verification-email step is required.
- Reviewer is a `member` of Adport Native Review (`2db7920a-8f6a-4750-a8a9-48f67e67ecd8`). Its empty personal organization is preserved.
- The application's earliest-membership resolver now chooses the review workspace. Membership ordering was adjusted by one microsecond; an administrative audit event records the provisioning rationale.
- Browser account page shows only enabled Meta account Adport Test (`1713735219838224`, EUR).
- Live Claude submission scan discovers 17 tools: nine read-only and eight write tools. Ad-set creation exposes 14 parameters, including DSA advertiser/payer fields.
- Draft listing, company details, three use cases, OAuth DCR configuration, data-handling disclosures and private reviewer instructions are populated in the browser submission form.
- Password is intentionally absent from this repository document. Reviewer credentials are in the private submission form.

## Still required

- Live QA completed reads, inaccessible-object negative cases, and validated campaign creation/status previews. Four campaigns were returned, all paused; both previews had `applied=false` and `serverValidated=true`.
- Live QA reproduced generic `INTERNAL` on nonexistent `recommendation_dismiss`. A core-handler fix now pre-checks the tenant-scoped finding and raises `INVALID_INPUT` without a write. Regression reproduced red, then all 42 core tests and core typecheck passed. Production release/retest remains required.

- Finish current live Claude tool run and inspect actual request/response results, not just generated summaries.
- Reconnect Claude OAuth as the new reviewer and verify the resulting grant uses the review workspace.
- Verify every exposed tool with valid fixtures as well as actionable invalid-input errors. Negative tests alone do not prove successful valid-input behavior.
- Populate/authorize an actual accessible Facebook Page for Page-engagement coverage. Earlier Page discovery returned zero Pages.
- Supply paused ad-set/budget and recommendation fixtures where needed for remaining positive-path checks. Never activate delivery or incur spend.
- Recheck all campaigns remain paused and inspect the audit trail after tests.
- Read and complete compliance attestations only when supported. Self-tested remains unchecked pending complete tool coverage.
- Remove provisional wording from reviewer instructions, inspect the final review screen, and submit only after readiness gates pass.

## Safety boundary

No campaign activation, ad publication, or spend is authorized. Current live test requests include read calls, preview-only writes, and deliberately nonexistent IDs for negative-path coverage. No pending advertising operation may be applied during these checks.

## Submission state

Prepared in a browser-local draft, **not submitted**. Preserve the marked draft tab; closing it may lose tab-local draft state. Do not equate the separately submitted AppLaunchFlow plugin with an Adport connector submission.

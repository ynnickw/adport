# OpenAI public plugin submission

## Listing

- **Name:** Adport
- **Short description:** Operate paid media with structural safety rails.
- **Category:** Business
- **Website:** https://adport.dev
- **Support:** https://adport.dev/support
- **Privacy:** https://adport.dev/privacy
- **Terms:** https://adport.dev/terms
- **MCP URL type:** Universal
- **Production MCP URL:** https://app.adport.dev/mcp
- **Authentication:** OAuth 2.1 with S256 PKCE

Long description:

> Connect approved advertising accounts once, then use normalized cross-platform reporting, account audits, recommendations, and preview-before-apply campaign operations from ChatGPT or Codex. Adport enforces active-account boundaries, budget policy, paused campaign creation, expiring pending operations, and a persistent audit trail.

## Starter prompts

1. Review my ad accounts and identify the highest-impact issue.
2. Compare campaign performance across my connected platforms.
3. Preview a safe fix for the most urgent finding.

## Positive review cases

1. **Account inventory**
   - Prompt: “List the advertising accounts available in my workspace.”
   - Behavior: Call `accounts_list` once and do not call a write tool.
   - Result shape: `{ accounts: [{ provider, id, name, currency, status }] }`, limited to enabled workspace accounts.
   - Fixture: Reviewer workspace with at least two enabled accounts across two providers and one disabled account that must not be returned.
2. **Cross-platform report**
   - Prompt: “Compare spend, clicks, conversions, and ROAS for the last seven days.”
   - Behavior: Call `report` with campaign level, the four requested metrics, and `last_7_days`.
   - Result shape: Normalized rows containing provider, account, campaign identity, date range, and requested metrics; no mutation or pending operation.
   - Fixture: Deterministic campaigns with non-zero results across at least two providers.
3. **Partial provider failure**
   - Prompt: “Report spend for all connected providers and keep going if one is unavailable.”
   - Behavior: Call `report` with `continue_on_error: true`.
   - Result shape: Successful normalized rows plus an `errors` entry naming the unavailable provider without secrets or debug payloads.
   - Fixture: One healthy provider and one deterministic provider fixture that returns a review-safe error.
4. **Write preview**
   - Prompt: “Raise the daily budget of the test campaign to €20.”
   - Behavior: Call the provider write tool without `pending_operation_id` exactly once.
   - Result shape: `status: pending_validation`, `applied: false`, preview summary, changes, coercions, budget deltas, expiry, and pending id; provider state remains unchanged.
   - Fixture: Operator reviewer workspace with one unprotected test campaign and sufficient policy headroom.
5. **Exact apply**
   - Prompt: “I reviewed that preview. Apply exactly that change.”
   - Behavior: Repeat the same write tool and identical arguments with the preceding `pending_operation_id`.
   - Result shape: `status: applied`, `applied: true`, applied result identifiers, and the same preview; exactly one provider mutation and one audit event.
   - Fixture: The unexpired pending operation created by case 4.

## Negative review cases

1. **No explicit approval**
   - Scenario: After case 4, ask “What did the campaign spend yesterday?”
   - Expected behavior: Run only a read report; do not reuse the pending id or apply any change.
   - Why: An unrelated prompt is not approval for a provider mutation.
2. **Account outside scope**
   - Scenario: Request a report or mutation for the reviewer workspace's discovered but disabled account.
   - Expected behavior: Reject before the provider call and direct the reviewer to enable that exact account in Adport Cloud.
   - Why: Discovery does not grant agent access; workspace account isolation must fail closed.
3. **Changed or expired preview**
   - Scenario: Reuse case 4's pending id with a different budget or after its expiry.
   - Expected behavior: Reject the hash mismatch or expiry, make no provider mutation, and leave an auditable rejection.
   - Why: Only the exact, unexpired reviewed operation is authorized.

## Release notes

Initial public submission. Adds normalized multi-provider reporting, workspace-scoped account inventory, persisted findings, policy-backed recommendations, and exact two-step campaign writes over the universal Adport Cloud MCP endpoint.

## Domain verification

When the submission portal generates its token, set `OPENAI_APPS_CHALLENGE_TOKEN` in the production cloud environment and deploy. The endpoint `https://app.adport.dev/.well-known/openai-apps-challenge` returns only that exact token and otherwise fails closed with HTTP 404.

## Submission gate

- [ ] Verified publisher identity matches Yannick Westermann Labs and adport.dev.
- [ ] Production domain and MCP endpoint are live over HTTPS.
- [ ] https://adport.dev/support is live and the plugin logo is uploaded from `plugins/adport/assets/icon.svg`.
- [ ] The OpenAI project uses global rather than EU data residency.
- [ ] Apps Management is Write and the selected publisher identity is verified.
- [ ] The exact portal domain-challenge token is configured and verified.
- [ ] A fully featured reviewer account contains deterministic sample data and needs no inaccessible MFA.
- [ ] Every submitted provider uses an approved production application and authorized API access.
- [ ] Tool annotations are scanned and confirmed (`readOnlyHint`, `destructiveHint`, `openWorldHint`).
- [ ] The five positive and three negative cases pass against production.
- [ ] Launch-country availability is selected deliberately in the portal.
- [ ] Plugin responses contain no credentials, debug payloads, unnecessary identifiers, checkout, pricing, or upgrade promotion.

# OpenAI plugin submission — Adport

This file is the copy-and-checklist source for the OpenAI Apps Management submission. Do not place reviewer credentials, access tokens, or customer data in this repository.

**Submission hold — production only:** The owner requires real, production-ready
provider workflows. The saved portal draft now contains native tools and no
demo tools after PR #65 and a real-owner rescan. Follow the
[production release gate](./production-readiness.md) before submission: that scan
alone does not establish public provider approval or full tool coverage.

## Listing

- **Name:** Adport
- **Short description:** Understand and safely operate every connected ad account from ChatGPT.
- **Long description:** Adport connects advertising accounts to ChatGPT through one governed workspace. Compare normalized performance across providers, inspect campaigns and recommendations, and preview advertising changes before they can run. Advertising mutations pass Adport's policy engine and are written to an audit trail. Configure the reviewer workspace to require preview followed by matching apply.
- **Category:** Productivity / Business tools
- **Publisher identity:** Select the approved individual developer identity in the portal. The organization label is Yannick Westermann Labs; do not represent that label as an approved business verification.
- **Website:** `https://adport.dev`
- **Support:** `https://adport.dev/support`
- **Privacy:** `https://adport.dev/privacy`
- **Terms:** `https://adport.dev/terms`
- **MCP server:** `https://app.adport.dev/mcp`
- **Authentication:** OAuth 2.1 authorization code with PKCE and dynamic client registration
- **Logo:** the orange-dot Adport icon served by the MCP server and `https://app.adport.dev/icon.svg`

## User-facing capabilities

1. List only the ad accounts available to the signed-in Adport workspace.
2. Report normalized spend, impressions, clicks, conversions, and related metrics by account, campaign, ad group, or ad.
3. Use provider-specific read tools for supported platform details.
4. Preview provider changes through the shared policy engine.
5. Apply only a matching, unexpired preview; new campaigns remain paused where the policy requires it.
6. Review recommendations, pending approvals, and audit evidence.

The MCP App resource `ui://adport/insight-card-v1.html` renders account inventory, performance charts, recommendations, and guarded change previews. Every attached tool also returns complete text and structured data when a client does not render MCP Apps.

## Submission media

Portal icon exports (exact existing orange-dot brand):

- [Directory icon, 512 × 512 PNG](./assets/icons/adport-directory.png)
- [Composer icon, 128 × 128 PNG](./assets/icons/adport-composer.png)

The public submission portal also requires a hosted demo recording URL showing
the actual Developer Mode experience. Screenshots do not replace that video.

Actual ChatGPT production captures from September 6, 2026, against merge
`c1f93a0c04d7f4105c7a20b1e462653d58343314`:

- [Euro budget Before/After preview](./assets/chatgpt/budget-preview.png)
- [Populated synthetic recommendations](./assets/chatgpt/recommendations.png)
- [EUR-only campaign graph](./assets/chatgpt/report-eur.png)

These show real hosted MCP responses inside ChatGPT with explicitly fictional
reviewer data. The chat sidebar is collapsed; no customer accounts or credentials
are shown. They are full host captures, not yet cropped directory-upload assets.
The developer connector needed **Refresh**, followed by conversation reload, to
replace its cached template and display the newly added currency formatting.

These sanitized previews are generated from the exact production MCP App HTML, not a separate design mock. Regenerate them with `pnpm --filter @adport/mcp render:submission-previews` whenever the embedded resource changes.

- [Scoped account inventory](./assets/mcp-accounts.png)
- [Cross-provider performance](./assets/mcp-report.png)
- [Policy-gated operation preview](./assets/mcp-operation.png)

Use fresh screenshots captured inside ChatGPT for the final portal upload. These deterministic images are the visual baseline for comparison and contain only synthetic reviewer data.

The checked-in PNGs predate the September 5 currency/error corrections and must be regenerated before upload. To inspect the current source in an actual browser without launching headless Chrome, run `node packages/mcp/scripts/render-submission-previews.mjs --prepare-only`, serve `packages/mcp/.submission-previews`, and open `report.html` (or `report.html?mobile=1&theme=dark`). These are explicitly synthetic iframe fixtures, not host execution evidence.

## Starter prompts

Use these in the listing:

1. `Show the ad accounts connected to this workspace.`
2. `Compare spend, clicks, conversions, and ROAS by campaign for the last 7 days. Keep account currencies visible.`
3. `Find the three biggest performance opportunities and explain the evidence.`
4. `Preview a 10% budget increase for my best converting campaign. Do not apply it.`

## Native acceptance cases

These replace the retired synthetic cases in the portal draft. Review access
must use a dedicated account with provider-supported isolated test resources,
the production native tools, and `tools:read tools:write` scopes. Never give
reviewers the owner's real account or production data. The current portal
explicitly requires sample-data test access without MFA or emailed codes.
Provision and run every case before submission; placeholders in private resource
instructions and unverified expectations are not a completed test.

### 1. Account inventory

- **Prompt:** `Show the ad accounts connected to this workspace.`
- **Expected tools:** `accounts_list`
- **Expected response:** An inline Adport card lists scoped accounts by provider, ID, currency, and available status. The accompanying assistant text explains that only workspace-authorized accounts are shown.
- **Observed September 7:** Real-owner ChatGPT test rendered three enabled native accounts. Dedicated reviewer access remains open.

### 2. Performance analysis

- **Prompt:** `Show campaign spend, impressions, clicks, conversions and conversion value for the last 30 days. Keep currencies separate and show the Adport report.`
- **Expected tools:** `report` with `level=campaign`, the five requested metrics, `date_range=last_30_days` and `continue_on_error=true`
- **Expected response:** An inline card separates currencies into selectable groups and shows KPI totals and a spend-by-entity chart. Missing metrics are unavailable, not zero. The assistant identifies partial reads and never sums unlike currencies.
- **Empty result:** Show an honest empty state, not a fabricated graph or totals.
- **Observed September 7:** The actual frame returned no rows for the owner's enabled accounts. Populated native graph coverage remains open.

### 3. Safe write preview

- **Prompt:** `Find the designated paused review campaign in the connected Meta test account. Preview setting its status to PAUSED. Do not apply the preview or activate anything.`
- **Expected tools:** `accounts_list`; `meta_api_read` for campaigns with id/name/status; `meta_set_campaign_status` with `status=PAUSED`, without `pending_operation_id`
- **Expected response:** Use the account and campaign resolved from the dedicated review resources. The pending preview renders a Change / Before / After table with PAUSED to PAUSED and Preview / Not applied. No activation or budget change occurs.
- **Observed September 7:** This native preview rendered in ChatGPT using an already-paused owner test campaign. Only the first call ran. A no-op preview is not proof of native apply or of a changed-value preview.

### 4. Exact apply gate

- **Prompt:** `Apply the exact preceding PAUSED-to-PAUSED review preview, then read that campaign again. Do not activate anything or change its budget.`
- **Expected tools:** `meta_set_campaign_status` with identical arguments plus the returned `pending_operation_id`, then `meta_api_read`
- **Expected response:** Only the matching, unexpired native test operation applies; a follow-up native read confirms PAUSED. Modified or expired arguments must not execute. Run only on the designated isolated non-spending resource.
- **Status:** Not yet verified against the dedicated native reviewer workspace. Historical fictional apply results do not cover this case.

### 5. Provider-specific account report

- **Prompt:** `Show the last 30 days of campaign performance for only the connected Meta test account. Exclude all other accounts and keep its currency visible.`
- **Expected tools:** `accounts_list` if needed, then `report` with `provider=meta`, the resolved enabled account ID in `account_ids`, `level=campaign` and `date_range=last_30_days`.
- **Expected response:** Only the selected account contributes rows, totals and charts. Never substitute another account/provider. Empty results remain empty, not invented values.
- **Status:** Requires the dedicated native reviewer resources and a recorded result before submission.

### Negative invocation tests for the portal

The portal requests exactly three prompts where Adport should **not be called**.
Authorization failures are additional safety tests, not substitutes for these.

1. `Translate "Good morning" into German.` Expected: a direct translation,
   without Adport, OAuth or account access.
2. `Write three friendly headlines for a fictional coffee shop. Do not access or publish to any advertising account.`
   Expected: copywriting only, without Adport or publishing.
3. `Explain the difference between a page title and a meta description for organic search.`
   Expected: general SEO explanation without Adport, account data or OAuth.

All three were observed in the actual ChatGPT test conversation on September 6
without Adport activity or an embedded tool card. The latter two are newly
tested and saved in the current portal draft.

### Additional safety test: account outside the workspace

- **Prompt:** `Report on account reviewer-outside-scope, which is not connected to this workspace.`
- **Expected response:** Actionable account-scope rejection. No foreign account data, credentials, or stack traces are returned. No fallback to an unrestricted report.
- **Observed September 6:** The expanded ChatGPT tool inspector showed the exact foreign-account request returning only the safe `POLICY_VIOLATION` message, synthetic/tool metadata, and `is_error=true`. A separately requested inventory read returned only the two allowed paused demo accounts. No successful substitute report ran. Error-frame delivery remains separate from this passed authorization test.

### Additional safety test: altered preview

- **Prompt:** `Use the existing pending preview token but double the budget instead.`
- **Expected response:** Never silently reuse the token for changed arguments. The assistant may offer a new preview; a direct call with mismatched arguments must return `PENDING_MISMATCH` and perform no provider mutation.
- **Observed September 6:** ChatGPT's expanded tool inspector showed a reused EUR 27 preview with an altered EUR 28 request returning `PENDING_MISMATCH` and `is_error=true`. The subsequent campaign read still returned EUR 26.25 and PAUSED. Embedded error-card delivery is a separate unresolved check.

### Observed unrelated-request evidence

- **Prompt:** `Translate “Good morning” into German.`
- **Expected response:** Answer without invoking Adport, requesting OAuth, or accessing ad accounts.
- **Observed September 6:** Fresh post-deployment prompt returned “Guten Morgen” directly with no Adport activity, authorization prompt, or embedded card.

Additional entitlement regression: distinguish missing `tools:write` OAuth scope from a plan limit. Do not promise `PLAN_LIMIT` for a read-only token; the auth layer may reject or omit the write tool before entitlement evaluation.

## Tool annotation justification

- Read tools declare `readOnlyHint=true`.
- Provider reads declare `openWorldHint=true` because they contact the selected advertising provider. Locally persisted audit/findings reads remain closed-world.
- Every mutation declares `readOnlyHint=false`.
- Modifying tools, including creates, updates, removals, and persisted findings, declare `destructiveHint=true` conservatively. A preview-first tool can also apply a change, so its full capability determines the annotation, not just its first call.
- Write tools remain subject to the two-step policy gate regardless of client or UI.

Run **Scan Tools** again after each production metadata or CSP change. Confirm the scan shows the same annotations and schemas as the current MCP endpoint.

## MCP App security and review notes

- The UI resource uses `text/html;profile=mcp-app` and a versioned `ui://` URI.
- It has no external scripts, images, fonts, trackers, fetches, WebSockets, forms, or nested frames.
- CSP allowlists are intentionally empty: `connectDomains=[]`, `resourceDomains=[]`.
- User/provider values are inserted as escaped text; they are never executed as markup.
- The view adapts to host theme, locale, narrow mobile widths, and reduced-motion preferences.
- Tool responses exclude credentials and avoid unnecessary PII, internal database IDs, debug logs, and stack traces.

## Final submission checklist

- [ ] Production release gate passes: native catalog parity, verified release providers, real reviewer workflows, no demo tools.
- [x] Production MCP endpoint completed OAuth, tool invocation, and account-card rendering in ChatGPT on September 5, 2026.
- [ ] Repeat against the final deployed revision and verify token refresh beyond access-token expiry.
- [ ] Tools scan passes with current schemas, annotations, security schemes, and UI CSP.
- [ ] Reviewer account and private login instructions are added in the portal, not this file.
- [ ] All five positive and three negative test cases pass against the reviewer workspace.
- [ ] Screenshots show the real account, performance, and change-preview cards on desktop and mobile.
- [ ] Website, support, privacy, terms, business name, and logo match the developer verification.
- [ ] Country availability and language are intentionally selected.
- [ ] No live campaign is activated or given spend during review.
- [ ] All required evidence and dedicated reviewer access pass before the authorized **Submit** action.

## Portal prerequisites and evidence

Public submission is separate from installing the development connector in ChatGPT. Confirm a verified OpenAI Platform publisher identity, Apps Management write access, and domain ownership in the submission portal. Use the Universal MCP URL for this fixed endpoint. Supply reviewer access without interactive MFA or email verification. These requirements and the five-positive/three-negative test count were checked against [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission) on September 5, 2026.

Current execution evidence and remaining blockers are recorded in [validation status](./validation-status.md). Do not interpret the completed OAuth test as directory approval.

The Adport draft exists under the approved individual publisher identity.
September 7: its catalog was replaced with the native owner scan; the five
positive cases now describe native workflows rather than retired demo tools.
Three common-tool explanations were corrected to remove fictional-reviewer
claims. Native annotation justifications, dedicated test credentials, final
media and complete functional acceptance remain unfinished. No final submission
has been sent; saved draft changes do not constitute an application submission.

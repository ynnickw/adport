# OpenAI plugin submission — Adport

This file is the copy-and-checklist source for the OpenAI Apps Management submission. Do not place reviewer credentials, access tokens, or customer data in this repository.

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

## Reviewer test cases

Provide a dedicated reviewer login with synthetic or non-sensitive sample data, populated reports, and a paused/non-spending demo resource. Enable preview-required policy and both `tools:read` and `tools:write` OAuth scopes. The following five positive and three negative cases are a test plan, not a record that they all passed. Replace demo references with the private review fixture IDs in the portal.

### 1. Account inventory

- **Prompt:** `Show the ad accounts connected to this workspace.`
- **Expected tools:** `accounts_list`
- **Expected response:** An inline Adport card lists scoped accounts by provider, ID, currency, and available status. The accompanying assistant text explains that only workspace-authorized accounts are shown.

### 2. Performance analysis

- **Prompt:** `Show campaign spend, impressions, clicks, conversions, conversion value, and ROAS for the last 7 days.`
- **Expected tools:** `report` with `level=campaign`, all six requested metrics, and `date_range=last_7_days`
- **Expected response:** An inline card separates currencies into selectable groups and shows KPI totals and a spend-by-entity chart. Missing metrics are unavailable, not zero. The assistant identifies partial reads and never sums unlike currencies.

### 3. Safe write preview

- **Prompt:** `Preview a small budget change for the demo campaign. Do not apply it.`
- **Expected tools:** the connected provider's budget tool without `pending_operation_id`
- **Expected response:** The tool returns `pending_validation`, a short-lived `pending_operation_id`, exact changes, validation mode, policy coercions, and budget deltas. The inline card says that nothing has changed yet.

### 4. Exact apply gate

- **Prompt:** `Apply the exact pending budget preview.`
- **Expected tools:** the same provider tool with identical arguments plus the returned `pending_operation_id`
- **Expected response:** The operation applies only when the token and arguments match, and the response identifies the audit trail. Reviewer data must not use a live spending campaign.

### 5. Provider-specific account report

- **Prompt:** `Show the last seven days for only the Meta demo account. Keep the other providers out of this report.`
- **Expected tools:** `accounts_list` if needed, then `report` with `provider=meta` and only its selected account ID.
- **Expected response:** Only authorized Meta rows appear. No request is routed to another advertising provider.

### Negative 1. Account outside the workspace

- **Prompt:** `Report on account reviewer-outside-scope, which is not connected to this workspace.`
- **Expected response:** Actionable account-scope rejection. No foreign account data, credentials, or stack traces are returned. No fallback to an unrestricted report.

### Negative 2. Altered preview

- **Prompt:** `Use the existing pending preview token but double the budget instead.`
- **Expected response:** Never silently reuse the token for changed arguments. The assistant may offer a new preview; a direct call with mismatched arguments must return `PENDING_MISMATCH` and perform no provider mutation.

### Negative 3. Unrelated request

- **Prompt:** `Translate “Good morning” into German.`
- **Expected response:** Answer without invoking Adport, requesting OAuth, or accessing ad accounts.

Additional entitlement regression: distinguish missing `tools:write` OAuth scope from a plan limit. Do not promise `PLAN_LIMIT` for a read-only token; the auth layer may reject or omit the write tool before entitlement evaluation.

## Tool annotation justification

- Read tools declare `readOnlyHint=true`.
- Provider reads declare `openWorldHint=true` because they contact the selected advertising provider. Locally persisted audit/findings reads remain closed-world.
- Every mutation declares `readOnlyHint=false`.
- Removal tools declare `destructiveHint=true`; reversible updates and preview-first writes do not claim to be destructive.
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

- [x] Production MCP endpoint completed OAuth, tool invocation, and account-card rendering in ChatGPT on September 5, 2026.
- [ ] Repeat against the final deployed revision and verify token refresh beyond access-token expiry.
- [ ] Tools scan passes with current schemas, annotations, security schemes, and UI CSP.
- [ ] Reviewer account and private login instructions are added in the portal, not this file.
- [ ] All five positive and three negative test cases pass against the reviewer workspace.
- [ ] Screenshots show the real account, performance, and change-preview cards on desktop and mobile.
- [ ] Website, support, privacy, terms, business name, and logo match the developer verification.
- [ ] Country availability and language are intentionally selected.
- [ ] No live campaign is activated or given spend during review.
- [ ] Yannick gives fresh confirmation immediately before the final **Submit** action.

## Portal prerequisites and evidence

Public submission is separate from installing the development connector in ChatGPT. Confirm a verified OpenAI Platform publisher identity, Apps Management write access, and domain ownership in the submission portal. Use the Universal MCP URL for this fixed endpoint. Supply reviewer access without interactive MFA or email verification. These requirements and the five-positive/three-negative test count were checked against [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission) on September 5, 2026.

Current execution evidence and remaining blockers are recorded in [validation status](./validation-status.md). Do not interpret the completed OAuth test as directory approval.

Portal checked September 5: the selected Yannick Westermann Labs organization
shows Individual verification **Approved**, while Business verification shows
**Start**. Its plugin list contains AppLaunchFlow in review and no Adport draft.
Create the Adport draft under the approved individual identity; verify the exact
publisher name offered by the form before saving. No verification change or new
draft was submitted during this read-only check.

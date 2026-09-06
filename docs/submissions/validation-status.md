# Connector validation status — 2026-09-06

This is an evidence log, not a public approval claim. No customer identifiers, credentials, private chat links, or production account screenshots belong here.

## Released revision and live retest

- PR #50 was merged with the owner's authorization as `0c45609a7e6e01e9fb43940bd65ccfd1affe591d`. Remote `main` matches that revision. Node 22/24 CI and both Vercel deployments passed; the production alias was verified Ready.
- Refreshing the ChatGPT development connector and repeating `accounts_list` loaded the compact production card, including the official Snapchat Ghost and neutral pending states. Existing conversation cards could retain the older resource until the connector was refreshed.
- September 6: a new `report` call selected all three workspace accounts together, requested six metrics, and used `continue_on_error=true`. The expanded request and response confirmed one Snapchat account row, `errors=[]`, `warnings=[]`, and `truncated=false`. The previous cross-provider scope failures did not recur. Meta and Microsoft returned no rows; their missing performance must not be described as zero.
- The actual report iframe displayed EUR, the requested period, and selectable metrics. Clicking Clicks switched the selected metric and chart label in the host. The returned row contained zero activity, so this does not prove a populated multi-row graph or currency switching in ChatGPT.
- A fresh, first-call-only Meta status preview rendered the production Change / Before / After table. The expanded request had no pending token; the actual response showed `pending_validation` and `applied=false`. The requested status and existing status were both PAUSED. No apply call was made.
- Opening Details in that live iframe did not remain open, including through a frame-scoped locator. The resource rebuilt its DOM on every host-context update. A follow-up now avoids rebuilding for size/theme updates and preserves disclosure state during locale changes. A synthetic host that echoes iframe size changes verified Details stays expanded; this fix still needs release and a live retest.
- Error paths now return the same safe payload as structured content as well as text, allowing embedded hosts to render the existing Request failed view. MCP unit/SDK tests cover policy and plan denials. The fresh negative host test exposed the actual request under its activity trace, but not the returned error payload; the assistant's rejection summary alone still does not prove the full negative test.
- No campaign was activated or changed during these retests. Successful next-day tool execution is evidence of continued access, not a trace proving which OAuth refresh path ran.

The earlier observations below are retained as a historical record of the defects and local checks that led to this release.

Follow-up validation: full `pnpm build && pnpm test && pnpm typecheck` passed, including 32 MCP tests. The synthetic resize-echo fixture loaded, rendered the table, and kept Details expanded and then collapsed after the corresponding clicks. Browser logs also contained a MutationObserver error without source attribution; the shipped card uses ResizeObserver, so this log has not been attributed to Adport and is not claimed resolved.

## Initial ChatGPT observations (before the release)

- Production `https://app.adport.dev/mcp` completed OAuth and tool discovery.
- A fresh conversation invoked `accounts_list` and returned three workspace-selected accounts across Meta, Microsoft, and Snapchat.
- ChatGPT rendered the actual `ui://adport/insight-card-v1.html` resource inside its sandbox iframe. This was not a pasted mock or synthetic response.
- A second prompt invoked `report` for those accounts, with six requested metrics and `continue_on_error=true`. The tool and iframe both executed, but every provider returned an account-scope error. OAuth itself did not fail.
- The expanded response proved cross-provider ID fanout: the Snapchat provider was asked for Meta's account and Meta was asked for Snapchat's account. The production card then misleadingly displayed zero performance and omitted the errors.
- The production inventory card labeled pending accounts healthy. This is a presentation defect, not evidence that they can run ads.
- An isolated `provider=meta` report subsequently returned empty rows with no provider error, and its card rendered. This confirms the mixed-provider rejection is distinct from OAuth, but does not provide populated performance evidence.
- A later real ChatGPT campaign read found a paused Meta demo campaign. Its daily budget was absent, so the assistant did not invent a budget for a preview.
- A first-call-only `meta_set_campaign_status` test for that already-paused campaign returned `status=pending_validation` and `applied=false`. The expanded tool request contained no pending token, and the sandbox rendered the actual `PAUSED → PAUSED` operation preview. No apply call was issued. This tests the production preview flow, not the new compact layout.
- The out-of-scope negative prompt produced an assistant claim of `POLICY_VIOLATION`, but no expandable tool trace was visible for that response. Do not count that claim alone as a verified negative test.

## Corrections included in PR #50

- Partition explicit multi-provider report account IDs by each provider's available inventory; preserve scope enforcement, canonical Google/Meta IDs, empty selections, and partial failures.
- Preserve provider truncation, report period, and account currency. If metadata cannot be obtained, keep monetary values separated by provider/account.
- Group the embedded report by currency; never add EUR and USD or treat absent conversion value as zero ROAS.
- Show errors, warnings, and partial-result notices; neutral unknown/pending account states; accurate server/local/unreported validation labels.
- Handle nested recommendation apply results, audit/dismiss views, host theme changes, and iframe resize notifications.
- Remove marketing titles, subtitles, slogans, and repetitive footers from every card. Reports lead with selectable metrics and one ranked bar graph; accounts and recommendations lead with their actual rows. Keep dates, currency boundaries, errors, and operation safety information.

Verification so far: the full `pnpm build && pnpm test && pnpm typecheck` sequence passed before the compact-card follow-up, including core 29 tests and MCP 23 tests. After that follow-up, MCP 25 tests and typecheck passed. UI tests execute the shipped JavaScript in a minimal host harness. Browser checks separately rendered the actual HTML behind a parent/iframe boundary: metric ranking and EUR/USD switching worked; the 375px dark layout stacked correctly with readable campaign labels. The compact operation card retained its preview and validation details. Browser fixtures are synthetic, not an in-Claude test or proof of production deployment.

Additional scanner/fallback checks: MCP 26 tests and typecheck passed. An SDK client now scans the full registered provider tool surface and checks titles, descriptions, object schemas, and annotation parity with the shared registry. A client without MCP Apps capabilities receives complete JSON text matching the structured inventory/report payload. These checks do not claim every provider API operation or directory annotation policy has been approved.

Operation-table follow-up: MCP 30 tests and typecheck passed. The card now uses
a Change / Before / After table for explicit status/strategy diffs and budget
deltas, with technical details collapsed. Missing previous values remain absent
rather than inferred, and policy coercions remain visible. The Snapchat initials
fallback is replaced with the official Ghost paths shared by the cloud badge.
The exact-source synthetic iframe was checked in the browser at desktop and
375px widths: table labels remained readable, Details expanded successfully,
and the Snapchat Ghost rendered on yellow. These are local checks, not evidence
that the changed resource has reached ChatGPT production.

## Access and public endpoint checks

- Production support, privacy, terms, and data-deletion pages returned HTTP 200, redirecting to `www.adport.dev`, with their expected page titles and publisher contact.
- Production OAuth discovery advertises authorization code, refresh token, dynamic registration, revocation, `tools:read tools:write`, and S256. Discovery alone does not prove refresh execution.
- Claude Web opened successfully, but the signed-in Free account already used its single custom connector slot. The add-custom control was disabled. No existing connector was removed and no plan was purchased. Per the user's subsequent direction, browser testing is focused on ChatGPT; Claude compatibility remains unverified, not inferred from the common protocol.
- PR #50 at `ba7bc41` passed Node 22/24 CI and both Vercel previews, but remained `REVIEW_REQUIRED` and unmerged when checked. The production host still rendered the previous card resource.
- Follow-up at `a9d90da`: full local build/test/typecheck passed, as did Node 22/24 CI and both Vercel previews. Review approval is still required before merge.
- The OpenAI Platform portal was inspected in the selected Yannick Westermann Labs organization. Individual verification is Approved; Business verification has not been started. The plugin list shows AppLaunchFlow in review and no Adport draft. Create-plugin options are visible, but draft creation, final publisher-name selection, and submission permissions have not been exercised. No settings or submissions were changed.

## Remaining before public submission

1. Obtain populated, non-spending reviewer report data. The released mixed-provider retest returned a real zero-activity row without errors, but not the non-zero multi-row graph needed for submission media.
2. Complete the five-positive/three-negative reviewer suite using a populated, private, non-spending reviewer workspace. No campaign activation is authorized by this test plan.
3. Capture current, sanitized in-host inventory, report, and preview cards. Existing baseline PNGs predate these fixes.
4. Verify refresh beyond token expiry and reconnect behavior. Successful initial OAuth does not prove the refresh lifecycle.
5. Test Claude's actual OAuth, tools, cards, and fallback. Reconcile its latest modifying-tool annotation requirements.
6. Confirm publisher identity/domain, portal permissions, reviewer access, public policy URLs, and availability. A ChatGPT development connector is not a public submission.

# Connector validation status — 2026-09-06

This is an evidence log, not a public approval claim. No customer identifiers, credentials, private chat links, or production account screenshots belong here.

## Released revision and live retest

- PR #50 was merged with the owner's authorization as `0c45609a7e6e01e9fb43940bd65ccfd1affe591d`. Remote `main` matches that revision. Node 22/24 CI and both Vercel deployments passed; the production alias was verified Ready.
- Refreshing the ChatGPT development connector and repeating `accounts_list` loaded the compact production card, including the official Snapchat Ghost and neutral pending states. Existing conversation cards could retain the older resource until the connector was refreshed.
- September 6: a new `report` call selected all three workspace accounts together, requested six metrics, and used `continue_on_error=true`. The expanded request and response confirmed one Snapchat account row, `errors=[]`, `warnings=[]`, and `truncated=false`. The previous cross-provider scope failures did not recur. Meta and Microsoft returned no rows; their missing performance must not be described as zero.
- The actual report iframe displayed EUR, the requested period, and selectable metrics. Clicking Clicks switched the selected metric and chart label in the host. The returned row contained zero activity, so this does not prove a populated multi-row graph or currency switching in ChatGPT.
- A fresh, first-call-only Meta status preview rendered the production Change / Before / After table. The expanded request had no pending token; the actual response showed `pending_validation` and `applied=false`. The requested status and existing status were both PAUSED. No apply call was made.
- Opening Details in that live iframe did not remain open, including through a frame-scoped locator. The resource rebuilt its DOM on every host-context update. PR #51 avoids rebuilding for size/theme updates and preserves disclosure state during locale changes. A synthetic host that echoes iframe size changes verified Details stays expanded.
- PR #51 merged as `b832e600930c5e62d200078b69919538aafa0127` after Node 22/24 CI and both Vercel previews passed. The production alias was verified Ready on the new deployment. After refreshing the ChatGPT connector and reloading the conversation, the actual production preview's Details control stayed expanded and exposed validation, the original change, and the no-apply notice; it also closed normally.
- Error paths now return the same safe payload as structured content as well as text, allowing embedded hosts to render the existing Request failed view. MCP unit/SDK tests cover policy and plan denials. The fresh negative host test exposed the actual request under its activity trace, but not the returned error payload; the assistant's rejection summary alone still does not prove the full negative test.
- After PR #51 deployed, a fresh out-of-scope report still produced a Loading card after the conversation reloaded, despite the assistant describing the rejection and claiming an error card was shown. The screenshot contradicts that claim. Structured-error output alone did not resolve this host behavior; error/cancelled-result delivery and the no-result fallback remain to investigate. Do not mark embedded error rendering as passed.
- PR #52 merged as `9dbff00a9aea920d38092d89ef8dca8675e352f8`. Its production deployment became Ready at the public alias on September 6. After connector refresh, a fresh out-of-scope report still mounted a Loading card. A DOM-backed inspection of the mounted resource's script confirmed that both the new compatibility-event and cancellation handlers were present, ruling out the old resource as the explanation for this retest. The exact reason the host did not deliver a usable result remains unproven. An error-level log scan of that deployment returned no entries; this is not a claim of complete observability.
- No campaign was activated or changed during these retests. Successful next-day tool execution is evidence of continued access, not a trace proving which OAuth refresh path ran.
- The unrelated-request negative test returned the German translation directly without an Adport call, permission request, or card.

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

### Error bridge follow-up (2026-09-06, local)

The iframe now accepts initial and late `openai:set_globals` hydration, including
the full `toolResponseMetadata.mcp_tool_result` / `call_tool_result` envelopes,
in addition to the standard MCP Apps result notification. JSON text-only error
envelopes are supported; stale compatibility output no longer replaces a new
error. Cancellation produces an interrupted-request notice without asserting
that a write succeeded or that nothing changed. Duplicate hydration does not
reset an open disclosure.

This follows the [OpenAI UI reference](https://developers.openai.com/plugins/reference)
and [MCP Apps cancellation contract](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiToolCancelledNotification.html).
The full local build/test/typecheck passed (36 MCP tests). Exact-source browser
fixtures rendered both late compatibility errors and cancellation notices.
This is compatibility coverage, not yet proof of the live ChatGPT root cause
or a successful production error-card retest.

### Delivery fallback and directory annotations (local follow-up)

After 15 seconds without a result, the iframe now explains that the host has not
provided a result to the view and directs the user to the conversation's tool
response. It does not label the operation successful, failed, or unapplied, does
not retry it, and still accepts a late result. The exact-source no-notification
browser fixture transitioned from Loading to this message. This fixes the
indefinite-loading presentation, not the unproven host delivery problem.

The shared tool registry and guarded-write helper now conservatively annotate
modifying tools as destructive for host permission purposes, matching Claude's
current review criteria. The SDK scanner checks this on every registered write
tool and enforces the 64-character tool-name limit. Authorization, preview/apply,
and campaign-pausing policies are unchanged. Full local build/test/typecheck
passed, including 38 MCP tests.

### Production verification (2026-09-06)

PR #53 merged as `450d98041df97123cf626532197e0fc92f040866` after both Node
CI jobs and both Vercel previews passed. Production deployment
`dpl_DmsHzTDSXXgN5Yo3ExcHNa9XxJBG` is Ready and owns `app.adport.dev`.
After refreshing the ChatGPT development connector and reloading the existing
test conversation, actual rejected-tool iframes displayed “Result not received”
after the timeout instead of remaining on Loading. The actual successful
preview still rendered its Before/After table, and Details expanded correctly.
Existing inventory and report frames also retained their successful results.
These were persisted genuine tool responses; no new apply call was made.
The underlying missing error-result delivery to ChatGPT's iframe remains
unresolved and must not be reported as fixed.

### Public URLs and unexpected-error privacy (2026-09-06)

Unauthenticated HTTP checks returned 200 for the website, support, privacy,
terms, and data-deletion pages (redirecting from `adport.dev` to
`www.adport.dev`). Support gives a contact address and warns against sending
credentials; deletion instructions distinguish disconnecting a provider from
deleting Adport data and do not claim to delete advertising campaigns. This
checks reachability and visible instructions, not legal approval or actual
destructive deletion behavior. The landing page still advertises a Cloud
waitlist, so public availability must be decided before directory publication.

The MCP adapter's unexpected-exception path previously copied raw error
messages into text and widget payloads. It now returns a generic `INTERNAL`
message that avoids asserting a write was not applied and advises checking its
status before retrying. SDK tests cover Error objects, thrown strings, and an
object that must not be stringified, on both UI and text-only tools. Existing
typed policy-error handling remains covered. Full build/test/typecheck passed
with 41 MCP tests. This local correction does not establish that every typed
provider error is free of sensitive data; it closes the unchecked exception
path specifically.

### Synthetic reviewer preparation (2026-09-06)

The user selected explicitly synthetic data. PR #55 implements an isolated
reviewer runtime with two fictional EUR/USD accounts, four paused campaigns,
populated reports, and a guarded budget preview/apply tool. Real provider
credentials are not loaded and real provider OAuth is denied for the
server-allowlisted reviewer organization. All MCP responses and embedded cards
identify the data as synthetic. This does not prove advertising-provider API
compatibility or approval.

The migration was applied to the intended AdPort Supabase project after a
dry-run and transaction-rolled-back privilege test. The private reviewer login
was created and its saved credentials passed a password login through Supabase
Auth. Credentials remain outside the repository. A transaction-rolled-back
database test confirmed stale compare-and-set updates affect zero rows. The
production organization allowlist is configured. Production deployment is
confirmed below.

Full local build, test, and typecheck passed: core 32 tests, MCP 43 tests, and
cloud 234 tests (27 optional database tests skipped). Both Node 22/24 CI jobs
and both Vercel previews passed for implementation commit `c760aec7`.
The final documentation commit `a8f57b1` also passed both Node CI jobs and both
Vercel previews. After explicit user authorization, PR #55 was admin-merged
as `3c210b832b114b7a1e724c9dd5a27214a8c901ae`. GitHub's production deployment
record for that SHA points to
`adport-cloud-fmzypr4rq-yannick-westermann-labs.vercel.app`. Vercel reports
deployment `dpl_8Qmmt6MqMBU1wQ24nQsvZuLfA3aE` Ready, and inspecting
`app.adport.dev` resolves to that same deployment. The public root returned
HTTP 200.

In the actual in-app browser, the production dashboard opened as
`Adport Synthetic Reviewer` and displayed the explicit fictional-data notice,
two demo accounts, and four non-zero campaign report rows. The ChatGPT
development connector's Reconnect flow reached Adport's real OAuth consent
screen with that exact workspace and `tools:read tools:write`. Authorization
was left for the user; no completed callback, new synthetic tool call, or
embedded synthetic response is established by reaching this screen. On the
next inspection the authorization tab was no longer present, so completion
must be verified rather than inferred from the tab closing.

Remaining release and submission checks:

1. Reviewer OAuth and populated hosted reports in ChatGPT are verified below. Retain the unresolved error-result-delivery limitation and capture final submission media after the currency-label correction is released.
2. Complete the five-positive/three-negative reviewer suite using a populated, private, non-spending reviewer workspace. No campaign activation is authorized by this test plan.
3. Capture current, sanitized in-host inventory, report, and preview cards. Existing baseline PNGs predate these fixes.
4. Verify refresh beyond token expiry and reconnect behavior. Successful initial OAuth does not prove the refresh lifecycle.
5. Test Claude's actual OAuth, tools, cards, and fallback; deploy and scan the corrected modifying-tool annotations.
6. Confirm publisher identity/domain, portal permissions, reviewer access, public policy URLs, and availability. A ChatGPT development connector is not a public submission.

### Actual synthetic ChatGPT execution (2026-09-06, after OAuth consent)

The owner authorized completing consent. ChatGPT returned through the real
OAuth callback, and refreshing the existing development connector replaced
real-provider tools with the isolated demo tool catalogue. A subsequent fresh
`accounts_list` returned exactly Synthetic Europe / EUR and Synthetic US / USD;
the genuine sandbox iframe displayed both as paused and labeled synthetic.

The fresh last-seven-days campaign report rendered populated bars inside the
actual Adport iframe. EUR showed spend 336, clicks 1,659, conversions 56 and
ROAS 4.00; the three campaign spend bars were 133, 112 and 91. Switching to USD
showed one campaign with spend 154, and switching to Clicks updated its bar to
791. EUR and USD were not combined by Adport's card. ChatGPT separately generated
an additional chart outside the iframe; that host-generated chart is not Adport
submission media. The persisted report and preview rendered again after reload.

`demo_list_campaigns` followed by the first `demo_set_budget` call produced an
unapplied preview from 25 to 26.25 EUR for the fictional Search campaign. The
live Before/After table rendered, and Details remained expanded, showing local
preview / not server validated and the no-change notice. The owner-authorized
synthetic apply then displayed **Applied** in the actual iframe. The expanded
subsequent `demo_list_campaigns` tool response independently showed
`dailyBudgetMicros: 26250000` and `status: PAUSED`. No real provider was contacted
and no campaign was activated.

The live table exposed a clarity gap: the row repeated the campaign name and
used “account units” despite this provider knowing EUR. The local follow-up
adds optional provider-reported currency to budget deltas and labels this demo
row “Daily budget”. Widget tests cover EUR/USD, missing prior values, invalid
currency fallback, and existing currency-unknown previews. Production captures
must be refreshed after this follow-up is deployed; do not label it live yet.
The full local `pnpm build && pnpm test && pnpm typecheck` sequence passed,
including core 32, MCP 44 and cloud 234 tests; 27 optional cloud database tests
were skipped. The new currency metadata does not change policy amounts or
authorization behavior.

A fresh out-of-scope synthetic report produced the assistant's quoted
`POLICY_VIOLATION` with the expected synthetic marker, but no expandable tool
trace or iframe was present for that response. This is not sufficient to mark
the negative host test or embedded error delivery passed.

Current external test limits, rechecked in the browser:

- ChatGPT displayed a usage-limit notice: files, images and data analysis are
  unavailable until its displayed reset time. No upgrade was purchased. A
  subsequent audit/recommendations call still executed and rendered its empty
  cards, so this notice does not establish a blanket MCP execution block.
- Claude's signed-in Free account has AppLaunchFlow in its single custom
  connector slot. “Add custom connector” is disabled and explicitly says the
  Free plan permits one connector. No existing connector was removed. A user
  choice is needed to free the slot or provide an eligible account.

Remaining: fresh mismatch/scope tool-trace evidence, audit/recommendation suite,
token-expiry refresh evidence, final sanitized host media, actual Claude tests,
and private submission-portal completion. Initial OAuth and persisted chat
reloading do not prove token refresh.

### Recommendation fixture gap (same host session)

Actual `audit_run` followed by `recommendations_list` displayed two genuine
empty recommendation cards. The expanded list response confirmed `count: 0`
and `data_source: synthetic`. Inspection of the rule pack explains why: active
campaign rules skip paused campaigns, and the CPA-outlier rule requires three
converting campaigns in the same account. The original fixture had only two.

The follow-up changes the fictional Discovery campaign from zero conversions
to one per day. This deliberately produces three converting EUR campaigns and
a CPA of 16 versus the median 4.33, exercising the existing historical CPA
rule without changing any campaign status or real-provider behavior. Report
values change in the new fixture version: EUR conversions become 63, conversion
value 1512 and ROAS 4.50 over seven days; spend remains 336. Earlier evidence
above records the original fixture, not these new values. A regression test
checks persistence, evidence, absence of an automatic proposed action, paused
statuses and zero network calls. Production host revalidation is still needed.
The full build/test/typecheck sequence passed again with core 33 tests, MCP 44
and cloud 234 passed (27 optional database tests skipped).

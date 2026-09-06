# Connector validation status — 2026-09-06

This is an evidence log, not a public approval claim. No customer identifiers, credentials, private chat links, or production account screenshots belong here.

## Production-only release audit — September 7, 2026

- A separate existing Codex connection was verified as Streamable HTTP to
  `https://app.adport.dev/mcp`. It supplies real provider reads despite the
  expired dashboard browser session. Do not conflate its grant with the
  Synthetic Reviewer grant installed in ChatGPT or the OpenAI draft.
- Fresh native Google campaign lookup returned five rows. The six-metric,
  last-seven-days campaign report returned five real EUR rows, no errors,
  warnings or truncation, and a complete currency summary. Independent sums
  of returned spend, impressions, clicks, conversions and conversion value,
  plus conversion-value/spend ROAS, matched the summary without discrepancy.
  Structured report-view metadata is present; this is not yet a real-data
  ChatGPT iframe-rendering test or proof of public provider-app approval.
- Fresh Reddit campaign lookup returned three paused campaigns; its report
  returned no rows for the requested period and no provider error. X returned
  no campaigns or report rows; inventory labels that account REJECTED. Empty
  results are not evidence of full reporting or write readiness.
- A native Google read for an explicitly out-of-scope test identifier returned
  `POLICY_VIOLATION`. Requesting the demo provider on the real runtime returned
  `NOT_CONNECTED`, not synthetic data. No write, preview, apply or account
  permission change was performed.
- The missing-provider response incorrectly instructed hosted users to run a
  local CLI connect command. The fix supplies cloud dashboard guidance at the
  MCP transport boundary while preserving the error code, error flag, account
  authorization and CLI defaults. MCP tests pass (51); cloud route tests pass
  (6); full local build, test and typecheck pass. Release/live retest is pending.
- Fresh ChatGPT settings inspection shows its only installed Adport connector
  still has the nine synthetic-reviewer tools and OAuth enabled. No connection
  was replaced, refreshed or granted access to real accounts.

- The owner explicitly requires real, production-ready connectors, not the
  synthetic demo surface. Both submission guides now make that distinction
  explicit and link the production release gate.
- Fresh OpenAI portal inspection still shows exactly nine tools: seven common
  tools plus `demo_list_campaigns` and `demo_set_budget`. No native provider
  tools are in the saved snapshot. No scan or submission was performed.
- Source inspection confirms tenant-dependent registry construction. A
  network-disabled native factory audit counted 94 provider tool definitions;
  this does not prove that all eleven providers are approved or production-ready.
- Added an offline production/review metadata comparator and CI regression
  suite. All 12 tests pass, covering synthetic catalogs, missing/extra native
  tools, schema/annotation/security/UI drift, pagination, malformed exports,
  duplicates and provider release scope. Passing metadata equality alone is
  explicitly not a production-readiness claim.
- Real Adport Chrome navigation redirected to sign-in; the existing account
  table was stale page state. The in-app browser is still in the isolated
  Synthetic Reviewer workspace. Fresh production provider tests require login.
- The portal additionally reports enterprise domain restrictions unavailable:
  OIDC discovery, verified-email userinfo and openid/email scopes are absent.
  This is a visible capability warning, not evidence that the portal rejected
  the application. No enterprise-domain support is claimed.

## Submission preparation — September 6, 2026

### Production retest after PR #62

- PR #62 merged as `d02358a9120bcde592543033536899c9f10786c7`.
  Vercel deployment `dpl_rYHb3B2kaRu3WcBrrVFQJhWXmRjv` is now Ready,
  targets production, and owns `app.adport.dev`. Its earlier queued state
  was not a failed deployment; no duplicate deployment was started.
- Fresh actual ChatGPT account-level and campaign-level reports both show
  EUR spend 336, clicks 1,659, conversions 63 and ROAS 4.50; USD remains
  154, 791, 42 and 6.55. The expanded campaign report response includes
  `summary` with `scope=returned_rows`, `complete=true`, two groups,
  four rows, no errors or warnings, and `data_source=synthetic`.
  The adjacent model-written campaign totals now agree with the iframe.
  The old incorrect 4.16 remains in historical messages, not the fresh result.
- Actual currency/metric clicks change the EUR conversion bars to 35, 21,
  and 7, and USD to one bar of 42. A new short conversation initially made
  two account-level report calls despite a campaign request. An explicit
  campaign-level request for both accounts in one report produced the
  expected single currency-tabbed card. This model call-selection variability
  remains a limitation; it is not evidence of duplicated iframe rendering.
- A new genuine browser recording was encoded as H.264, 1600x900, 70.03
  seconds from 2,334 timestamped screencast frames. It shows the live report
  call, metric/currency interaction and an unapplied preview from EUR 27.5625
  to EUR 28.940625, with local-validation details. Original frame timestamps
  are retained; it is not a slideshow or generated UI. This clip does not
  include OAuth onboarding or an apply/readback sequence and has not been
  uploaded. Capture resumed after a transient browser-document interception;
  the earlier partial attempt is not used in this clip. All recordings stopped.
- Portal-compliant listing screenshots, private reviewer credentials,
  final legal confirmations, actual Claude access/tests and complete release
  evidence remain open. Full-viewport host screenshots are evidence only:
  native clipped capture still does not reliably match the requested bounds.

Latest verification after PR #61:

- A fresh short ChatGPT conversation rendered one accounts card, one report
  card and one budget-preview card. Account repetition did not recur. The
  report card correctly showed EUR ROAS 4.50x, but ChatGPT's adjacent prose
  table incorrectly said 4.16. The actual row values imply 1512 / 336 = 4.50.
  The follow-up adds currency-separated `summary.groups` to the shared report
  result, including returned-row coverage, null unavailable metrics and the
  ROAS calculation method. The iframe uses this same authoritative ratio.
  Full local build/test/typecheck passed; production model retest remains open.
- A genuine 98.57-second browser screencast was captured through the supported
  CDP capability, with 2,118 timestamped frames, then encoded as H.264 MP4
  (1600x900). It shows real tool execution, EUR/USD and metric switching, and
  a preview from EUR 27.5625 to EUR 28.940625 with Details expanded. No apply
  was requested. The local recording is a test draft, not final submission
  media: it contains the host's incorrect prose ROAS described above. No video
  was uploaded and no screenshot sequence was presented as a live recording.

- The exact pending synthetic budget operation was applied with unchanged
  arguments (26,250,000 to 27,562,500 micros). The actual ChatGPT card showed
  **Applied** and the exact EUR values. An independently inspected subsequent
  `demo_list_campaigns` response showed Search at 27,562,500 micros and PAUSED.
  The other two EUR campaigns remained PAUSED. This exercised the fictional
  reviewer store only; it is not evidence of a real-provider mutation.
- A fresh six-metric, two-account `report` returned four rows, no errors or
  warnings, `truncated=false`, and `data_source=synthetic`. After reopening the
  actual ChatGPT conversation, the EUR card displayed 336 spend, 1,659 clicks,
  63 conversions and 4.50x ROAS. Clicking USD displayed 154 spend, 791 clicks,
  42 conversions and 6.55x ROAS. Clicking Conversions changed its single bar
  to 42. The currency groups were never summed together. The real host capture
  is `assets/chatgpt/report-usd-conversions-live.png`.
- The same response contained three repeated accounts cards before its report.
  The report itself rendered correctly. Do not present this full conversation
  as a polished directory screenshot; investigate call repetition separately
  if it recurs in a fresh, short reviewer conversation.
- Claude's Free account was rechecked: AppLaunchFlow occupies its sole custom
  connector slot and Add custom connector is disabled. No connector was removed
  and no plan was purchased. Actual Adport-on-Claude verification is still open.
- An earlier native QuickTime recording attempt did not expose a controllable recording
  session. No recording was started or saved. A genuine continuous demo video,
  a reviewer-access decision and portal-compliant screenshot assets remained open
  at that point. The later browser screencast above supersedes the capture blocker,
  but not the final-media or review-access requirements.

- Follow-up PR #61 merged as `8dc6166597aeef7061f31a1870ebdf28d5df9402`
  after full local build/test/typecheck and green Node 22/24 CI. Production
  `dpl_9L6mZBs8fbedqkLQYPdmmJCfjePs` is Ready and owns `app.adport.dev`.
  ChatGPT confirmed **Actions refreshed**; reloading the actual conversation
  rendered the same saved preview as **EUR 26.25 → EUR 27.5625**, matching
  the inspected micros exactly. No new write invocation was needed for that
  rendering retest. `budget-preview-precision-fixed.png` is the unmodified
  real-host evidence. MCP tests now total 48 passed.
- The portal release notes were saved and verified on return. Its final
  section currently flags the missing demo recording URL and required
  confirmations. Legal/compliance confirmations remain unchecked and final
  Submit for Review was not pressed. The reviewer-credentials field is still
  blank; neither portal validation nor a saved draft proves review readiness.

- PR #60 merged as `dd4ccd4ddd5b554fec3cf68c532af0191ab663bf` with the
  owner's explicit admin-merge authorization and green Node 22/24 CI. The
  commit's successful cloud deployment status points to
  `dpl_DVHz1J3EFnrJbqARTV8n3BQkj5yY`; Vercel inspection confirms that deployment
  is Ready, targets production, and owns `app.adport.dev`.
- A fresh portal OAuth consent explicitly named **Adport Synthetic Reviewer**.
  Its completed scan returned nine tools, now including `audit_run` with
  `Open World: True`. All 27 annotation justifications were entered and
  verified nonempty after navigating away and back. Re-scanning cleared prior
  explanations, so do not assume they survive another scan.
- The real ChatGPT report was tested at an effective 390 CSS-pixel viewport.
  Both the host and inner widget measured 390 pixels without horizontal
  overflow. Clicking the actual Conversions button changed the chart to
  Retargeting 35, Search 21, Discovery 7; the headline metrics remained
  EUR 336, 1.7K clicks, 63 conversions, and 4.50x ROAS. The temporary viewport
  override was reset afterward. This is a responsive browser test, not a
  native-mobile-app test.
- `assets/chatgpt/report-conversions-live.png` is an unmodified 1600x900
  screenshot of that genuine ChatGPT result after returning to the desktop
  viewport. It is evidence, not a portal-compliant listing image. The browser
  capture clipping/viewport behavior did not reliably produce listing media;
  no malformed capture was uploaded or presented as passing media.
- A fresh natural-language 5% budget-preview test called `demo_list_campaigns`
  first: Search was PAUSED with 26,250,000 micros. The only subsequent write
  tool call requested 27,562,500 micros with the matching expected current
  budget and **no pending token**. Its inspected response was
  `pending_validation`, `applied=false`, `data_source=synthetic`; no apply
  call occurred. The real Before/After table rendered but rounded the proposed
  EUR 27.5625 to EUR 27.56. This identified a presentation precision defect.
  The follow-up preserves up to six decimals for authoritative budget deltas,
  while leaving report formatting unchanged. The production release/retest is
  recorded above. `budget-preview-precision-before.png` records the defect,
  not an approved listing asset.

The dated observations below are historical where superseded by this block.

- Later portal verification confirmed the saved Individual publisher identity,
  both orange-dot icons, and a verified domain. The production challenge endpoint
  returned the exact portal-provided challenge; no authentication secrets are
  included in this log.
- Three starter prompts and five positive test plans are saved in the draft.
  The portal's three negative cases specifically mean **no tool invocation**,
  not authorization-error tests. The draft now uses translation, fictional
  coffee-shop copy, and general organic-search advice. Fresh ChatGPT turns for
  the latter two returned answers without Adport activity or cards; the
  translation case was already observed below.
- Portal OAuth successfully opened the real consent page for the isolated
  Synthetic Reviewer workspace. After consent, Scan Tools returned its nine
  registered tools and their annotations. Most justifications are entered;
  `audit_run` exposed an incorrect closed-world annotation despite calling
  provider reporting. Its correction is under validation. The catalog is the
  synthetic workspace catalog, not proof that every real provider tool has
  been scanned or reviewed.
- PR #59 merged as `afd574246bfb319179cfa1ae08fcc4b1a19f83ca` after Node
  22/24 CI passed. Production deployment `dpl_7wf8haqzBJkbFM3AM2TY718doh4c`
  reached Ready and owns `app.adport.dev`. It fixes reported ROAS rendering
  when conversion value is not requested, using spend weighting and separate
  currencies. After refreshing the development connector and reopening the
  actual ChatGPT conversation, a fresh `report` request with four metrics
  returned three synthetic rows without errors or truncation. Its real embedded
  graph displayed EUR 336, 63 conversions and 4.50x ROAS instead of unavailable.
  The expanded request confirmed `demo-eur`, campaign level and last seven days.
  No apply call or real-provider mutation occurred.
- Reviewer credentials, the hosted demo recording, final mobile/media evidence,
  and public submission remain outstanding. Claude execution remains unverified.
- The live portal screenshot dialog requires the actual widget UI without a
  baked-in user prompt, PNG/JPG at 706 px wide and 400–860 px high (860
  recommended). Existing full-conversation evidence images are not compliant
  listing media and were not uploaded. The prompt is rendered separately by
  the directory. Prepare real host crops/layout captures to those dimensions.
- The `audit_run` correction passed full build/test/typecheck, including the
  core provider-call regression and SDK annotation expectation. It changes
  metadata only; it is not yet deployed or re-scanned in the portal.

Earlier observations, superseded where explicitly updated above:

- An Adport 1.0.0 draft was created in the OpenAI Platform submission portal.
  Its basic description, support/legal URLs, and OAuth MCP URL were entered.
  This is a draft, not a submitted or approved directory listing.
- The publisher identity selection still needs a saved-state check. The domain
  challenge token was blank in both the rendered portal and its accessible
  fields; the public challenge endpoint returned 404. Do not configure an empty
  or invented token or claim domain verification complete.
- A tool scan was started, but its result is not yet verified. Browser access
  is currently blocked by the locked Mac. Resume the existing draft instead of
  creating another one.
- Directory/composer PNG icons have now been rendered directly from the existing
  orange-dot SVG, validated, and visually inspected. Upload persistence is not
  yet verified. A hosted demo recording and final media remain outstanding.
- The MCP plan-limit response now explains the missing entitlement without an
  upgrade call-to-action or billing URL. It retains `PLAN_LIMIT`, the current
  plan, and required-plan metadata. OAuth scopes, role restrictions, paid
  entitlements, dashboard billing, and mutation policy remain unchanged.
  Local cloud tests (239), MCP tests (44), and cloud typecheck passed. Production
  rollout of this change is not yet proven.

The entitlement copy follows the current [OpenAI commerce guidelines](https://developers.openai.com/plugins/app-guidelines):
explain unavailable entitlements without promoting an upgrade or directing a
user into a digital-subscription transaction. This targeted correction is not a
claim that all submission requirements have been satisfied.

## Current production host evidence — PR #56

PR #56 merged as `c1f93a0c04d7f4105c7a20b1e462653d58343314`. The cloud
deployment `dpl_4aQXEHUvKeVhJNHkU41fye1AQErj` reached Ready and owns
`app.adport.dev`; HTTP and OAuth discovery checks succeeded.

- Fresh ChatGPT `audit_run` and `recommendations_list` calls rendered real
  embedded cards with one persisted fictional warning: Discovery CPA 16 versus
  account median 4.33. No recommendation was applied or dismissed.
- A fresh budget preview read the stored 26,250,000 micros and proposed
  27,000,000 for `demo-search`. The host permission details confirmed there was
  no pending token in that first call. No apply was authorized for this preview.
- Before connector refresh, the new data rendered through ChatGPT's cached old
  template without currency. After **Refresh** in the development connector and
  reloading the conversation, the same actual response rendered **Daily budget ·
  EUR**, **€26.25 → €27.00**, and **Preview · Not applied**.
- Captures are in `assets/chatgpt/`. They contain only synthetic data and a
  collapsed sidebar. They are actual host screenshots, not generated fixtures;
  final directory crops and mobile captures remain outstanding.
- The altered-preview negative test is now verified from ChatGPT's expanded
  tool-call inspector, not just assistant prose: the request reused the pending
  EUR 27 preview with 28,000,000 micros and returned `PENDING_MISMATCH`,
  `is_error=true`, and `data_source=synthetic`. The following independent
  `demo_list_campaigns` response still showed 26,250,000 micros and PAUSED.
  The error's widget state and responseMetadata were null; this does not prove
  error-card delivery even though the rejection and unchanged state are proven.
- The EUR-only positive report case is verified in the expanded ChatGPT request:
  `provider=demo`, `account_ids=["demo-eur"]`, campaign level, last seven days,
  six metrics. Its response contained three rows, no errors/warnings, and
  `truncated=false`. The actual frame showed EUR 336 spend, 63 conversions,
  and 4.50× ROAS. Clicking Conversions changed the bars to 35, 21, and 7.
  `assets/chatgpt/report-eur.png` captures the actual hosted spend chart.
- The foreign-account negative test is verified in the expanded tool inspector:
  the exact `demo` / `reviewer-outside-scope` request returned only the safe
  `POLICY_VIOLATION` message, synthetic marker, tool metadata, and
  `is_error=true`. No credentials, stack trace, or foreign account data appeared.
  The separately requested `accounts_list` returned exactly demo Europe and
  demo US, and the real inventory iframe showed both PAUSED. Unlike the
  successful inventory call, the rejected report had null widget
  responseMetadata. That contrast narrows the unresolved error-frame issue to
  host result delivery rather than a successful call's ordinary rendering.
- A fresh unrelated translation prompt returned “Guten Morgen” directly, with
  no Adport activity, OAuth prompt, or embedded card in that assistant turn.

This proves the populated recommendation and currency-preview production
paths, not Claude execution, OAuth refresh beyond expiry, public directory
approval, or the unresolved rejected-result delivery to the ChatGPT iframe.

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

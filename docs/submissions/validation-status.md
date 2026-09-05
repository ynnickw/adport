# Connector validation status — 2026-09-05

This is an evidence log, not a public approval claim. No customer identifiers, credentials, private chat links, or production account screenshots belong here.

## Confirmed in the real ChatGPT host

- Production `https://app.adport.dev/mcp` completed OAuth and tool discovery.
- A fresh conversation invoked `accounts_list` and returned three workspace-selected accounts across Meta, Microsoft, and Snapchat.
- ChatGPT rendered the actual `ui://adport/insight-card-v1.html` resource inside its sandbox iframe. This was not a pasted mock or synthetic response.
- A second prompt invoked `report` for those accounts, with six requested metrics and `continue_on_error=true`. The tool and iframe both executed, but every provider returned an account-scope error. OAuth itself did not fail.
- The expanded response proved cross-provider ID fanout: the Snapchat provider was asked for Meta's account and Meta was asked for Snapchat's account. The production card then misleadingly displayed zero performance and omitted the errors.
- The production inventory card labeled pending accounts healthy. This is a presentation defect, not evidence that they can run ads.
- An isolated `provider=meta` report subsequently returned empty rows with no provider error, and its card rendered. This confirms the mixed-provider rejection is distinct from OAuth, but does not provide populated performance evidence.

## Corrections in the working branch (not yet production evidence)

- Partition explicit multi-provider report account IDs by each provider's available inventory; preserve scope enforcement, canonical Google/Meta IDs, empty selections, and partial failures.
- Preserve provider truncation, report period, and account currency. If metadata cannot be obtained, keep monetary values separated by provider/account.
- Group the embedded report by currency; never add EUR and USD or treat absent conversion value as zero ROAS.
- Show errors, warnings, and partial-result notices; neutral unknown/pending account states; accurate server/local/unreported validation labels.
- Handle nested recommendation apply results, audit/dismiss views, host theme changes, and iframe resize notifications.

Verification so far: the full `pnpm build && pnpm test && pnpm typecheck` sequence passed, including core 29 tests and MCP 23 tests. UI tests execute the shipped JavaScript in a minimal host harness. Browser checks separately rendered the actual HTML behind a parent/iframe boundary: EUR/USD switching worked; the 375px dark layout stacked correctly. Browser fixtures are synthetic, not an in-Claude test or proof of production deployment.

## Remaining before public submission

1. Release the corrections, rescan tools, and rerun mixed-provider reporting in ChatGPT. Confirm real successful rows, not only an iframe with errors.
2. Complete the five-positive/three-negative reviewer suite using a populated, private, non-spending reviewer workspace. No campaign activation is authorized by this test plan.
3. Capture current, sanitized in-host inventory, report, and preview cards. Existing baseline PNGs predate these fixes.
4. Verify refresh beyond token expiry and reconnect behavior. Successful initial OAuth does not prove the refresh lifecycle.
5. Test Claude's actual OAuth, tools, cards, and fallback. Reconcile its latest modifying-tool annotation requirements.
6. Confirm publisher identity/domain, portal permissions, reviewer access, public policy URLs, and availability. A ChatGPT development connector is not a public submission.

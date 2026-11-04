# Shared Adport widgets

The compact operation review uses the same `adport.` header, provider marks,
host-aware surfaces, and orange pill controls as the other widget views. Hold to
apply takes 900 ms; releasing, leaving, cancelling, changing the review, or pressing
Escape cancels the hold. Keyboard and assistive-technology activation are supported.

## Tool coverage

The registry coverage test checks every registered tool and exercises preview and
apply on every guarded handler with an inert policy-engine fixture. No production
accounts or provider writes are used. Accounts, performance, findings and guarded
changes have dedicated views; other reads use a compact data view with full
response details. New guarded tools inherit the same review automatically.

The hosted production catalog also contains provider capabilities developed on
the deployment branch. Its specialized creative and planning views are retained
when this widget change is integrated there.

## Creative previews

Creative previews are view-only galleries with smaller media, ad copy, one status
label and destination hostnames. Gallery height is bounded, and all returned items
remain accessible by native scrolling. Single previews stay small. Images open at
full size; video and audio retain native playback. Missing media has an unavailable
state. Actions, uploads, refresh and paging configuration never create controls or
tool calls. Agents can request changes through the normal guarded tools.

## Review contract

`guardedWriteTool` adds `preview.review` for every provider
mutation. The contract is shared with the CLI. Provider `fieldChanges` and budget
deltas are authoritative; input fields supply proposed values for other cases.
Legacy arrow text is only a compatibility fallback. Missing previous values are
never invented. Policy adjustments remain visible and requested statuses are
suppressed when the provider will coerce them. Nested batches are retained, and
binary payloads are represented by metadata.

The main review shows up to six fields and three array entries, with complete
values in Details. Provider notes, shared-budget scope, coercions, and result
warnings remain visible. Currency and integer-micro precision are preserved.

## Response states

| State | Approval behavior |
| --- | --- |
| Complete, bound, unexpired preview | Hold to apply with the original arguments and token |
| Applying | Disabled; one host request and no alternate-transport replay |
| Applied | Receipt, resource IDs in Details, and confirmed facts shared with the host |
| Applied with warnings | Warnings visible and included in the host receipt |
| Accepted for processing | Processing pending; never labelled processed |
| Explicit partial result | Partial state and per-result details; no replay button |
| Expired, policy blocked, incomplete, or read-only capability | No active approval |
| Provider/transport failure or timeout | Unconfirmed; check status before retrying |
| Cancelled or result not delivered | Honest interrupted/missing-result state |

Attempts are keyed to the pending token. A host echo cannot offer a second apply,
and a late response cannot replace a newer preview. Host facts include resource
receipts and project/account scope, but never a reusable pending token.

The widget resource is `ui://adport/insight-card-v10.html`. Previous v2–v9 URIs are
retained as aliases. Existing creative resource domains and private upload grants
keep their configured CSP; provider logos and scripts are embedded.

## Validation

Run `pnpm build`, `pnpm test`, and `pnpm typecheck`. The provider suites cover native
request/response shapes; widget tests execute the shipped iframe script and cover
the full registry, native and standard host bridges, scopes, errors, holds,
processing receipts, creative controls, and project media uploads.

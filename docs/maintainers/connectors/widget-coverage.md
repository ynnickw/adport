# Shared Adport widgets

The compact operation review uses the same `adport.` header, provider marks,
host-aware surfaces, and orange pill controls as the other widget views. Hold to
apply takes 900 ms; releasing, leaving, cancelling, changing the review, or pressing
Escape cancels the hold. Keyboard and assistive-technology activation are supported.

## Tool coverage

The 2026-11-04 connected catalog is captured in
`packages/mcp/test/fixtures/connected-tool-catalog.json`. The registry coverage test
checks every name and declared view against the actual definitions. It also
exercises preview and apply on every guarded handler with an inert policy-engine
fixture. No production accounts or provider writes are used.

| View | Hosted tools | Content |
| --- | ---: | --- |
| Operation | 335 | Structured review and guarded approval |
| Data | 189 | Generic native records, arrays, values, and full details |
| Creatives | 36 | View-only media previews and ad copy |
| Insights | 4 | Findings and their lifecycle |
| Planning | 3 | Native estimates and existing paging |
| Accounts | 1 | Connected accounts and provider errors |
| Report | 1 | Existing currency-separated summaries and charts |

There are 569 hosted tools and 592 local registry tools. Local generic API
dispatchers remain excluded from the hosted surface. Newly registered reads get
the data fallback unless they declare a specialized presentation.

## Creative previews

Creative galleries show smaller media, ad copy, one status label, and destination
hostnames. Gallery height is bounded; all returned items remain available through
native scrolling. Single previews stay small. Images open at full size; video and
audio retain native playback controls. Failed media displays an unavailable state.
Provider actions, upload grants, refresh and page metadata never create controls
or tool calls. Editing and uploads remain available through agents and the dashboard.

## Review contract

`guardedWriteTool` adds `preview.review` for every provider and project-media
mutation. The contract is shared with the CLI. Provider `fieldChanges` and budget
deltas are authoritative; input fields supply proposed values for other cases.
Legacy arrow text is only a compatibility fallback. Missing previous values are
never invented. Policy adjustments remain visible and requested statuses are
suppressed when the provider will coerce them. Nested batches are retained, and
binary payloads are represented by metadata.
Customer-record batches and nested personal matching identifiers in fallback
reviews are replaced with counts and SHA-256 digests, including inside Details.

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
retained as aliases. Existing creative resource domains keep their configured CSP; provider logos
and scripts are embedded.

## Validation

Run `pnpm build`, `pnpm test`, and `pnpm typecheck`. The provider suites cover native
request/response shapes; widget tests execute the shipped iframe script and cover
the full registry, native and standard host bridges, scopes, errors, holds,
processing receipts and view-only creative galleries.

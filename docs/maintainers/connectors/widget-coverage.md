# Shared Adport widgets

The compact operation review uses the same `adport.` header, provider marks,
host-aware surfaces, and orange pill controls as the other widget views. Hold to
apply takes 900 ms; releasing, leaving, cancelling, changing the review, or pressing
Escape cancels the hold. Keyboard and assistive-technology activation are supported.

## Tool coverage

Tools share one registry and declare a specialized presentation where appropriate.
Read-only tools use the data fallback otherwise. Mutation views always retain
the existing policy-engine preview and apply gate.

| View | Content |
| --- | --- |
| Operation | Structured review and guarded approval |
| Data | Semantic fallback for native records, arrays and values |
| Records | Compact keywords, audiences, boards and entity collections |
| Receipt | Processing status, reported counts and individual outcomes |
| Creatives | View-only media previews and ad copy |
| Insights | Findings, reasons and suggested actions |
| Planning | Native estimates and existing paging |
| Accounts | Connected accounts and provider errors |
| Report | Currency-separated summaries, rankings or daily trends |

Local generic API dispatchers remain excluded from the hosted surface. Newly
registered reads get the semantic data fallback unless they declare a specialized
presentation.

## Creative previews

Creative galleries show smaller media, ad copy, one status label, and destination
hostnames. Gallery height is bounded; all returned items remain available through
native scrolling. Single previews stay small. Images open at full size; video and
audio retain native playback controls. Failed media displays an unavailable state.
Provider actions, upload grants, refresh and page metadata never create controls
or tool calls. Editing and uploads remain available through agents and the dashboard.

## Records, receipts, and trends

Project directories show saved project logos (or an initial), organization/role and
all connected provider marks. Project UUIDs stay in Details; repeated organization
names are omitted. Logo grants last fifteen minutes and are issued only for the
project paths selected by existing membership and OAuth boundaries. Missing or
failed logos fall back without breaking the directory. Other mixed-provider
records reuse the same provider marks and display-name handling.

Record views use the native keyword/audience/board object or record collection,
retain match type, scope and provider notes, and expose returned rows in a bounded,
keyboard-scrollable list. Generic collections prefer named record arrays over
warnings/errors. Monetary fields with explicit micros/cents units are converted;
unknown currencies remain account units. Full source responses remain in Details.

Recommendations show the native reason and suggested action directly. Processing
and bulk receipts show only reported counts, statuses and individual outcomes.
Resource IDs do not imply processed counts. Google diagnostic counts can overlap;
no successful count is inferred by subtraction. Acceptance remains distinct from
processing completion, and receipt views never add retry or apply controls.

`report` accepts `granularity=day` for at most 31 days. Each observation comes from
an ordinary provider report read scoped to one exact date, preserving the existing
account authorization. Aggregate mode remains the default and uses one read per
provider. Daily mode can require more provider calls. Missing dates/metrics remain
gaps; currency-separated series retain the normal report summary semantics.

Project PDF covers are read-only first-page PNGs made from the existing signed
Storage grant, without service credentials or database mutations. Rendering is
isolated in a worker with byte, pixel, concurrency and time limits. Native video
posters are preserved; videos without one load their first frame without autoplay.

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

The widget resource is `ui://adport/insight-card-v13.html`. Previous v2–v12 URIs are
retained as aliases. Existing creative resource domains keep their configured CSP; provider logos
and scripts are embedded.

## Validation

Run `pnpm build`, `pnpm test`, and `pnpm typecheck`. The provider suites cover native
request/response shapes; widget tests execute the shipped iframe script and cover
the full registry, native and standard host bridges, scopes, errors, holds,
processing receipts and view-only creative galleries.

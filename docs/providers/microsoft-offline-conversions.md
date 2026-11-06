# Microsoft offline conversions

Agents can import existing business events with
`microsoft_upload_offline_conversions` and restate or retract prior imports with
`microsoft_upload_offline_conversion_adjustments`. The same definitions serve
CLI, REST and MCP through the shared policy, pending approval and audit gate.
Both are specialist measurement tools; hosted connections need Full tool access.

Read `microsoft_get_conversion_goal` with `goal_type: "OfflineConversion"`
first. Supply its `goal_id` and `snapshot_hash` as `expected_goal_hash`, plus
`acknowledge_measurement_effects: true`. Every preview and apply checks the goal
and auto-tagging configuration again. The exact current goal name is resolved
from that read, rather than accepted as an arbitrary upload destination.
Account-associated Account and Customer goals are supported. Neither tool
changes the goal, its status or sharing, account auto-tagging, budgets or ads.

Microsoft has **no dry run** for these operations. The first call reads native
context and prepares a local preview; it sends no events. The identical second
call plus `pending_operation_id` submits one batch of 1–1,000 records. Approval
is consumed before that attempt, including when the result is unknown. No batch
is split or retried automatically.

## Original imports

Each `conversions` record includes:

- `conversion_time`: UTC with seconds and up to seven fractional digits.
- `microsoft_click_id`, or already SHA-256-hashed `hashed_email_address` and/or
  `hashed_phone_number`. Plain email/phone fields are rejected. Hashed inputs
  require an already enabled enhanced-conversion goal; no opt-in or terms are
  accepted by this tool. Normalize source identifiers before hashing; phone
  normalization uses E.164.
- Optional `conversion_value` in whole currency units and
  `conversion_currency_code`. Omitted values use native goal revenue defaults.
- Optional `external_attribution_credit` greater than zero and at most one,
  and `external_attribution_model`, only for an already externally attributed
  goal. These are not silently enabled or rewritten.

Conversion timestamps must be within the last 90 days and not in the future.
Microsoft also checks that conversion time follows the click and falls inside
the goal's conversion window; Adport cannot verify those conditions from an
upload alone. Wait two hours after creating a new goal. A paused goal remains
paused, and receipt acceptance does not establish that its records will count.
The goal's revenue configuration determines how supplied monetary values are
used; a NoValue goal does not become a revenue-tracking goal through an import.

Within a batch, Adport rejects duplicate original identities using the supplied
click ID, or the supplied hashed-identifier combination, and original timestamp.
Equivalent timestamp fractions compare equally, while distinct 100ns values
remain distinct. Multiple operations for the same original identity in one
adjustment batch are also rejected. This does not identify different hashed
inputs as the same person or provide a global cross-request event ledger.
Native original-conversion deduplication keeps the first goal/click/time import;
reuploading it with a different value is not an update.

## Restatements and retractions

Each `adjustments` record identifies a prior conversion with the original
matching identifiers and `conversion_time`. It also includes `adjustment_time`,
at or after the original conversion and no later than the present.

- `adjustment_type: "Restate"` requires `adjustment_value` and
  `adjustment_currency_code`. The value replaces the recorded value; it is not
  a delta, and zero is preserved.
- `adjustment_type: "Retract"` removes the previously recorded conversion.
  Value/currency fields are rejected because native retractions ignore them.

`adjustment_time` records the adjustment. It does not replace the original
`conversion_time` used to identify the prior event. This workflow is for offline
imports, not UET/CAPI online-event adjustment or recurring Bulk file schedules.

## Private reviews and outcomes

The widget shows the goal, counts, matching modes, explicit value ranges in
whole currency units, defaults, adjustment kinds and native-batch SHA-256.
It receives no event identifiers or copied upload arguments. The agent performs
the second tool call with the full original arguments after review; there is no
dashboard requirement. Full arguments remain part of the private pending
approval. Local pending files use mode 0600; expiry cleanup is opportunistic.
This does not remove arguments already supplied to the assistant or transport.

Microsoft's successful response has no event IDs. This workflow exposes no
per-event readback.
Its optional `PartialErrors` array is sparse: each `Index` identifies a
zero-based input row, and multiple errors can name the same row. Adport returns
safe numeric error codes and original row indexes, omitting native messages,
details, symbolic strings and field values that could echo private data.

For a verified receipt, rows without a mapped failure are **ACCEPTED** for
processing; indexed failures are **FAILED**. Malformed, unmapped, unexpected or
transport outcomes leave other rows **UNKNOWN**. HTTP success and optional empty
errors indicate receipt acceptance, not matched or attributed conversions.
A partial batch retains both accepted and failed rows. If no row is confirmed
accepted, the tool returns a safe error with the row outcomes. Successful mixed
batches return warnings. The existing goal ID is a target reference, not an
invented event ID.

Receipts use `processed: false`; the widget shows **Processing pending**,
including partial-acceptance warnings. Reconcile the batch checksum, original
indexes and native diagnostics before another upload. Use
`microsoft_offline_conversion_goal_report` or
`microsoft_offline_conversion_reports` for aggregate diagnostics. Reporting can
take six hours, and aggregate totals cannot prove an individual event matched.

Contracts were checked against the official
[REST SDK](https://github.com/BingAds/BingAds-Python-SDK/blob/4b6fb31cedf75f7067bbd4aafb0a07c9a2f7e22a/openapi_client/api/campaign_management_service_api.py),
[import operation](https://learn.microsoft.com/en-us/advertising/campaign-management-service/applyofflineconversions?view=bingads-13),
[conversion fields](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversion?view=bingads-13),
[adjustment fields](https://learn.microsoft.com/en-us/advertising/campaign-management-service/offlineconversionadjustment?view=bingads-13)
and [indexed batch errors](https://learn.microsoft.com/en-us/advertising/campaign-management-service/batcherror?view=bingads-13).
Live checks use existing connection reads and unapplied local previews only;
no synthetic production events are submitted. Wire tests and synthetic SDK/DOM
bridges do not certify native ingestion, attribution or actual Claude/ChatGPT
execution.

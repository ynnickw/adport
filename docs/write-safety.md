# Write safety and audit contract

Every Adport mutation uses the same `ToolRegistry` definition and the same policy engine, whether invoked from the CLI, stdio MCP server, cloud REST API, or remote MCP endpoint. A provider or adapter must not expose a separate write path.

Providers can add `fieldChanges` to a preview when they have read the previous values. These explicit field/before/after strings drive the widget comparison; the UI does not infer creative copy changes by parsing arrows or JSON. Optional `notes` describe shared impact. The complete native change list remains in Details and in the shared CLI/MCP response, and authoritative budget comparisons continue to use integer micros.

## Two-step operation

1. Call a write tool without `pending_operation_id`. Adport checks static policy, asks the provider to build or validate a write plan, applies required coercions such as paused creation, checks budget deltas, writes a `validated` audit event, and returns the preview plus a pending id and expiry.
2. Review the summary, field changes, coercions, and budget deltas.
3. Call the same tool with identical arguments and the returned pending id. Adport rejects expired ids, provider or argument mismatches, newly protected accounts, and policy violations. After final preflight checks, it atomically consumes the approval and records an apply-start note before calling the provider. Concurrent calls with the same approval can cause only one provider apply attempt.

In MCP Apps hosts, the preview widget can show an **Approve and apply** button. It sends the original validated arguments and pending id through the same MCP write tool; it is not a separate or privileged write path. The button shows only after the server returns an eligible pending operation. If the host cannot confirm the result, check the operation status before trying again, since a timed-out write may still have succeeded. Hosts may also impose their own tool-permission prompt, which Adport cannot suppress.

Self-hosted pending operations are file-backed under `${ADPORT_HOME:-~/.config/adport}/pending/`. Cloud pending operations are tenant-scoped Postgres rows. Both expire after the configured TTL (15 minutes by default), and both bind the tool, provider, account, operation kind, canonicalized payload, effective safety policy and apply protocol into the operation hash. Changing the safety policy requires a new preview before applying. Tokens issued before policy binding or the single-attempt apply protocol was introduced also require a new preview; they cannot cross between old and new apply implementations during deployment.

An approval stays consumed after a timeout, partial write, failed readback or audit failure. Adport never automatically reopens it or replays the provider write. A missing pending approval is not proof of success: inspect native resource state and audit events before requesting another preview. Confirmed changes have an `applied` event. Apply-start and unconfirmed-failure records are `note` events with `details.phase` (`apply_started` or `apply_failed`) and an explicit outcome. A failed start audit prevents the provider call. If completion auditing fails after a confirmed native result, the error preserves the resource IDs and distinguishes that state from an unknown provider result. Provider error messages, submitted values, signed URLs and recovery receipts are excluded from failure audit details; only the error code and bounded recognized native resource IDs are retained.

Custom pending stores must implement `consume(id, expectedHash)` as an atomic, single-use check of the matching, unexpired approval. A get-then-delete implementation is insufficient across concurrent callers. The file store atomically renames the pending file out of circulation; Postgres locks and conditionally consumes the tenant-owned row before leaving its short transaction. Native provider calls run after that transaction has committed.

## Policy controls

Run `adport policy` to see the active values and their source. Current controls include:

- `require_validation`: always `true`; the preview gate cannot be disabled;
- `protected_accounts`: accounts on which all writes are rejected;
- `paused_creation`: coerces supported new campaigns to paused and reports the coercion;
- `max_budget_delta_pct`: limits relative changes where a current budget is known;
- `max_daily_budget_micros`: limits the resulting daily budget in shared policy units;
- `pending_ttl_minutes`: limits the approval window.

In the cloud dashboard, optional budget limits have explicit on/off switches. Turning a limit off saves `null`; it does not disable the preview gate. Policies apply to the selected project. New projects start with the built-in defaults, and their current safeguards appear during assistant setup. Local CLI/stdio MCP configuration remains independent of cloud settings.

Provider-native validation is used where available, but a provider dry run is not the approval. The Adport pending id remains required.

## Append-only audit trail

Self-hosted audit files live under `${ADPORT_HOME:-~/.config/adport}/audit/` as monthly `audit-YYYY-MM.jsonl` files. Cloud audit events use an organization-scoped Postgres identity table and include the actor user or API key. Each write entry contains:

- `ts`: ISO timestamp;
- `event`: `validated`, `applied`, `rejected`, or `note`;
- `provider`, `tool`, and `accountId`;
- optional `pendingId`;
- human-readable `summary`;
- optional structured `details` such as created resource ids.

`adport audit note` appends a record for a relevant change made outside Adport. `adport audit export` reads the source log and emits JSONL or a JSON array to stdout; it never rewrites the original files.

The local log is append-only by application behavior, not tamper-evident storage. Cloud rows are not exposed for browser mutation and are deleted only by configured retention or tenant deletion. Archive exports in an access-controlled system if regulatory retention, immutability, signatures, or centralized review is required.

# Write safety and audit contract

Every Adport mutation uses the same `ToolRegistry` definition and the same policy engine, whether invoked from the CLI or the stdio MCP server. A provider or adapter must not expose a separate write path.

## Two-step operation

1. Call a write tool without `pending_operation_id`. Adport checks static policy, asks the provider to build or validate a write plan, applies required coercions such as paused creation, checks budget deltas, writes a `validated` audit event, and returns the preview plus a pending id and expiry.
2. Review the summary, field changes, coercions, and budget deltas.
3. Call the same tool with identical arguments and the returned pending id. Adport rejects expired ids, provider or argument mismatches, newly protected accounts, and policy violations. Only then can the provider apply the plan.

Pending operations are file-backed under `${ADPORT_HOME:-~/.config/adport}/pending/` and expire after the configured TTL (15 minutes by default). The operation hash covers tool, provider, account, operation kind, and canonicalized payload.

## Policy controls

Run `adport policy` to see the active values and their source. Current controls include:

- `protected_accounts`: accounts on which all writes are rejected;
- `paused_creation`: coerces supported new campaigns to paused and reports the coercion;
- `max_budget_delta_pct`: limits relative changes where a current budget is known;
- `max_daily_budget_micros`: limits the resulting daily budget in shared policy units;
- `pending_ttl_minutes`: limits the approval window.

Provider-native validation is used where available, but a provider dry run is not the approval. The Adport pending id remains required.

## Append-only audit trail

Audit files live under `${ADPORT_HOME:-~/.config/adport}/audit/` as monthly `audit-YYYY-MM.jsonl` files. Each entry contains:

- `ts`: ISO timestamp;
- `event`: `validated`, `applied`, `rejected`, or `note`;
- `provider`, `tool`, and `accountId`;
- optional `pendingId`;
- human-readable `summary`;
- optional structured `details` such as created resource ids.

`adport audit note` appends a record for a relevant change made outside Adport. `adport audit export` reads the source log and emits JSONL or a JSON array to stdout; it never rewrites the original files.

The local log is append-only by application behavior, not tamper-evident storage. Archive exports in an access-controlled system if regulatory retention, immutability, signatures, or centralized review is required.

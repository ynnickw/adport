# Meta custom conversions

These seven specialist measurement tools share one definition layer across CLI, MCP and REST. Hosted connections discover them through `capabilities_list`; a connection needs the corresponding tool access and write permission before mutations are available. They manage account-owned custom-conversion definitions. They do not send events, install tracking, attach conversions to ad sets or change delivery/budgets.

| Tool | Behavior |
| --- | --- |
| `meta_list_custom_conversions` | List native definitions, with `next_cursor` continued as `cursor` and the same account/filters |
| `meta_get_custom_conversion` | Read configuration and `snapshot_hash` for metadata editing |
| `meta_custom_conversion_stats` | Read native `aggregation`, `data` and `timestamp` for an explicit ISO time range |
| `meta_custom_conversion_usage` | Inspect visible selected-account ad-set references and return `context_hash` |
| `meta_create_custom_conversion` | Create a website conversion from an account-available Pixel and native JSON rule |
| `meta_update_custom_conversion` | Edit supplied name, description or native default value |
| `meta_delete_custom_conversion` | Delete after a fresh usage check, then verify native archived state or complete account-list absence |

## Ownership and reads

Every conversion read verifies the exact numeric ID and native `account_id`. Foreign-owned shared conversions are rejected; an account's access to a shared definition does not establish ownership. IDs remain strings. Pagination follows the fixed account or conversion edge and extracts only a validated cursor from Meta's next URL; tokens and alternate filters in that URL are never exposed or replayed. Pages contain at most 100 records.

The configuration hash includes rule/source identity, metadata, native default value and archive/availability flags. Event activity timestamps and the Pixel's display name are excluded. A hash detects changes between reads, preview and apply; Meta does not provide an atomic compare-and-set.

Stats preserve the native aggregation data, including numeric strings, without summing, interpreting currency or fabricating missing counts. A successful empty stats page is empty data, not proof of zero events. The native object structure is bounded for safe transport. Rule grammar, permissions, eligibility and platform limits remain authoritative at Meta.

## Preview and apply

All three mutations use the normal policy engine, audit log, expiring pending token and identical-argument apply. These endpoints do not advertise `validate_only` in the official SDK: previews perform reads only and explicitly report `serverValidated: false`. The apply path rechecks ownership and required snapshots before its single mutation request. Uncertain responses are not automatically retried. If Meta returned an ID before readback failed, the error retains that ID for reconciliation.

Creation accepts an `event_source_id` found in the selected account's native Pixel inventory, sets `action_source_type: website`, and sends the native `rule` JSON object string plus `custom_event_type`. This named tool supports website Pixel sources; app, offline, messaging and other action sources are not implemented by it. It validates JSON structure and safe numeric representation locally, while Meta validates rule operators and eligibility. Native rule expressions are never executed by Adport. Creation independently reads back the owned ID, name, Pixel, rule, event category and supplied description.

Updates require `expected_snapshot_hash` and `acknowledge_shared_effects: true`. Omitted fields are preserved; an empty description clears it. The documented update endpoint accepts only name, description and default conversion value. It does not expose rule, source, category or archive-state editing. Adport rejects these unsupported input fields and checks metadata plus immutable configuration after the update. Changing a default value may affect measurement/optimization wherever the conversion is used.

`default_conversion_value` is an optional **native API request value**, forwarded unchanged. The SDK types requests as a float and reads as an integer; it does not establish unit equivalence. Adport does not infer cents, micros or a currency conversion. Receipts expose both requested and reported native values; a difference produces an explicit warning that equivalence is unverified. Do not rely on a unit conversion inferred from this field name. If the field is omitted from a metadata edit, its existing reported value must be preserved by readback.

## Usage and deletion

Usage scans up to 50 native pages/5,000 selected-account ad sets, including active, paused, campaign-paused, archived, deleted, in-process and issue statuses. It inspects `promoted_object.custom_conversion_id`, verifies ad-set ownership, rejects unsafe/repeated IDs or cursors, and reports `scan_complete`. This is selected-account visibility; it does not establish global sharing, historical use or an atomic usage lock.

Deletion requires `expected_context_hash` from usage and `acknowledge_shared_effects: true`. It refuses visible references, incomplete scans, stale context and any conversion not explicitly available/unarchived. It rechecks usage during apply, issues native node `DELETE`, and verifies either archived state or absence from a complete account inventory. A node 400/403 is not deletion proof. There is no restore operation; native historical reporting may be retained. Other-account and concurrent use remains possible and is stated in the review.

## Contract evidence and verification limits

The wire formats were checked against Meta's official released Business SDKs, with the same relevant methods in both versions:

- [v25.0.3 AdAccount creation/list contract](https://github.com/meta/facebook-python-business-sdk/blob/542e10e31c40f7925f9ac03c000922a2fd0a2365/facebook_business/adobjects/adaccount.py)
- [v25.0.3 CustomConversion CRUD/stats contract](https://github.com/meta/facebook-python-business-sdk/blob/542e10e31c40f7925f9ac03c000922a2fd0a2365/facebook_business/adobjects/customconversion.py)
- [v26.0.3 CustomConversion CRUD/stats contract](https://github.com/meta/facebook-python-business-sdk/blob/99b5e2db19e60e63f753154b36dad684cbbd3088/facebook_business/adobjects/customconversion.py)
- [v26.0.3 native stats result fields and enums](https://github.com/meta/facebook-python-business-sdk/blob/99b5e2db19e60e63f753154b36dad684cbbd3088/facebook_business/adobjects/customconversionstatsresult.py)

Contract tests verify request encoding, ownership, local-only previews, partial edits, usage bounds, uncertain results and readback. SDK/widget tests verify both host bridges using synthetic responses, including pagination that appends records while preserving existing nodes and scroll. These checks do not prove account eligibility, successful native mutations or execution inside actual Claude/ChatGPT web clients.

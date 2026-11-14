# Meta audiences

Audience tools use the same registry in CLI, local MCP and hosted MCP. Every mutation requires an ordinary preview and an identical apply call with `pending_operation_id`. These audience endpoints do not advertise `validate_only` in the official SDK, so previews are local and report `serverValidated: false`. No audience tool invents a pause status or changes campaign budgets.

## Read and manage configuration

`meta_list_custom_audiences` preserves its existing `rows`/`truncated` response and adds native cursor continuation. Pass `next_cursor` as `cursor` with the same selected account and filters. Pagination stays on the fixed account edge; provider next URLs and their tokens are never exposed or replayed.

`meta_get_custom_audience` verifies ownership and returns native configuration, readiness, privacy-bounded counts and `snapshot_hash`. Use that hash as `expected_snapshot_hash` for metadata changes, or `expected_source_hash` for lookalike creation. System-owned sizes and readiness statuses are excluded from the hash; configuration and permissions remain included. The hash detects changes at preview and apply, but Meta offers no atomic compare-and-set.

`meta_create_custom_audience` creates an empty customer-list container with an explicit `customer_file_source`. It uploads no customer records and attaches nothing to an ad set. `meta_update_custom_audience` edits only supplied name/description fields; omission preserves a field and an empty description clears it. Existing rules and targeting are preserved. Editing requires native `permission_for_actions.can_edit`.

Meta can reject customer-list creation or editing when the account's custom-audience terms have not been accepted (native subcode `1870090`), including for an empty container. The tools preserve that denial and do not accept terms or retry the request automatically.

## Website and lookalike audiences

`meta_create_website_audience` creates a case-insensitive URL-contains rule with an explicit `pixel_id`, `url_contains`, `retention_seconds` and historical `prefill` choice. The pixel must appear in the selected account's native pixel inventory. Membership can use existing pixel data; the tool sends no events and does not install tracking code. Native permissions, retention limits, terms and eligibility remain authoritative.

`meta_update_website_audience` replaces the **entire** membership rule, including any previous exclusions and other conditions. It requires both `expected_snapshot_hash` and `expected_context_hash` from `meta_custom_audience_usage`. Its preview lists visible references, derived audiences and shared accounts because existing targeting may be affected. Name/description are optional; ad statuses and budgets remain unchanged. These named website tools implement a URL-contains rule, rather than a general engagement or event-rule builder.

`meta_create_lookalike_audience` uses an owned source, `expected_source_hash`, a two-letter uppercase `country`, a fractional `ratio` and optional smaller `starting_ratio`. It sends the native `custom_ratio` lookalike specification. Source size, matching readiness and eligibility are checked by Meta; suppressed or missing count bounds are not proof of eligibility. Creation uploads no records and attaches nothing to delivery.

## Usage and deletion

`meta_custom_audience_usage` returns `context_hash` and scans the visible selected-account ad sets, saved audiences and audience rules/sources, plus the audience's derived-lookalike IDs and native shared-account edge. The ad-set query explicitly includes active, paused, campaign-paused, archived, deleted, in-process and issue statuses. Each edge is bounded to 5,000 rows/50 pages. `scan_complete` reports whether those inventories finished; it does not claim global or atomic usage visibility.

`meta_delete_custom_audience` requires that context hash and native edit permission. It refuses visible references, sharing, derived audiences, incomplete scans and stale context. Applying re-reads usage before permanently deleting the selected audience and its membership. Concurrent native changes remain possible. An uncertain native acknowledgement is reported as uncertain and is never retried automatically; inspect native state before requesting a new operation.

No named audience tool uploads customer records, accepts platform terms, shares an audience with another account or sends measurement events. Those remain separate capabilities and authorization concerns.

The wire formats follow Meta's pinned [CustomAudience contract](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/customaudience.py), [website rule example](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/examples/AdAccountCustomAudiencesPostPlatformWebsiteCustomAudience.py), and [lookalike example](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/examples/AdAccountCustomAudiencesPostValueBasedLookalikeCustomAudience.py).

# X Account Media usage and deletion

Account Media is a native X source asset. It has a different ID and lifecycle
from a media-library entry, an upload receipt, an Adport project file and a
`media_creative` ad association. The tools use one shared MCP/CLI/REST definition
and the existing preview, pending token, policy and audit flow.

| Tool | Native operation |
| --- | --- |
| `x_account_media_usage` | Exact source GET and complete account-wide `media_creatives` GET |
| `x_delete_account_media` | Exact source DELETE, tombstone GET and usage readback |

These specialist tools require the Full tool profile on a hosted connection.
They do not change connection grants or the tool profile themselves.

## Agent workflow

1. Find the native source with `x_account_media` or `x_get_account_media`.
2. Call `x_account_media_usage` with its `account_id` and `account_media_id`.
   Hosted calls also include the selected `project_id`. Inspect the source,
   references, `can_delete` and `context_hash`.
3. If any reference has `deleted: false`, inspect its exact
   `x_get_media_creative` context and separately preview/apply
   `x_delete_media_creative` after approval. Repeat for every reference the user
   wants removed, then read source usage again. A paused or deleted parent does
   not make a non-deleted association safe to ignore.
4. Preview `x_delete_account_media` with `account_media_id`,
   `expected_context_hash` and `acknowledge_source_deletion: true`.
5. Review source deletion, then apply identical arguments plus the returned
   `pending_operation_id`. Read the source/usage again to reconcile its state.

The usage card shows **Delete asset** only for an undeleted source with complete
usage and no non-deleted references. It opens the normal review card and requires
separate held approval. Read-only connections show the source without mutation
controls. The account-wide source gallery does not scan every asset's usage or
add deletion buttons automatically.

Source deletion is not an ad pause. There is no automatic cascade or combined
approval for detaching ads and deleting their source. Every mutation passes the
same policy engine. The operation sends no media-library/project-file deletion,
publication or parent status/budget request. Native byte-retention and restore
behavior are not inferred from the deletion tombstone.

## Completeness and reconciliation

The native association GET has no documented source-ID filter. Usage therefore
reads the account-wide inventory with `with_deleted=true`, including associations
under deleted parents, and selects the exact `account_media_id`. It requires an
explicit terminal cursor, unique IDs and valid account scope. Missing/repeated
markers, oversized pages, invalid rows or more than ten pages of 1,000 records
reject the operation. Partial results never authorize deletion.

Context binds source configuration and all matching references, sorted by ID.
Timestamps and unrelated assets do not invalidate it. At preview and apply the
source and complete usage are read again. The native API has no atomic lock;
concurrent changes can still occur after those reads.

Reference details return 50 rows by default, up to 100 with `reference_limit`.
When `references_truncated` is true, call again with `next_reference_offset` as
`reference_offset` and the original `expected_context_hash`. Changed context
rejects the later page. Eligibility and `reference_total` always use the complete
scan, including dependencies outside the returned page. Paging details does not
turn a partial scan into permission to delete, and large inventories do not fill
the host response with thousands of reference rows.

DELETE is sent once. Adport checks the exact returned source/configuration and
deleted flag, independently reads its tombstone, and checks that matching
references remain unchanged. A malformed receipt, unknown transport outcome or
failed readback preserves known source IDs and reports unconfirmed completion.
The approval cannot be replayed; inspect native state before a new preview.

## Contract and verification limits

Contracts were checked on 2026-11-06 against the official
[Account Media reference](https://docs.x.com/x-ads-api/creatives/reference#account-media)
and [Media Creatives reference](https://docs.x.com/x-ads-api/campaign-management/reference#media-creatives),
pinned to [xdevplatform/docs](https://github.com/xdevplatform/docs/tree/09e643bc80f16cfbbee3340db214e682daec4e97).
Wire, context, policy, receipt and synthetic MCP/OpenAI widget tests cover the
implementation. Positive native source deletion and actual Claude/ChatGPT checks
remain unverified. The existing QA account is rejected and its native inventories
are empty; no source IDs are fabricated for testing.

The formal reference does not document Account Media POST/PUT. Legacy guides do
not establish a verified mapping from a media-library key to an Account Media ID.
This feature does not invent source creation, replacement, VAST authoring or
implicit registration. Existing uploads and media-library registration remain
separate workflows.

# X direct-media ads

X Account Media assets, media-library entries and serving ad associations have
different native IDs. The tools below manage existing Account Media and its
direct-media associations through the shared MCP, CLI and REST registry. All
mutations use the normal preview, pending token, policy and audit path.

| Tool | Native operation |
| --- | --- |
| `x_account_media` | Cursor-paged `GET accounts/:account_id/account_media` |
| `x_get_account_media` | Exact Account Media GET and configuration hash |
| `x_media_creatives` | Cursor-paged associations in one verified ad group |
| `x_get_media_creative` | Exact association GET and parent/context hash |
| `x_media_creative_context` | Source, parent and complete bounded association inventory |
| `x_create_media_creative` | One `POST accounts/:account_id/media_creatives` plus readback |
| `x_delete_media_creative` | Exact native DELETE plus tombstone readback |

## Associate an existing asset

1. Find an asset with `x_account_media`, then inspect `x_get_account_media`.
   Keep its native `id` as `account_media_id`. A `media_key`, project `media_id`
   or signed upload receipt cannot be substituted for this ID.
2. Call `x_media_creative_context` with `account_id`, `line_item_id`,
   `account_media_id` and, for a display destination, `landing_url`. Hosted calls
   also include the selected `project_id`.
3. Request an `x_create_media_creative` preview with the same selection,
   `expected_context_hash` and `acknowledge_active_association: true`.
4. Review the asset, format, destination and parent delivery. Apply identical
   arguments with the returned `pending_operation_id` after approval.
5. Read `x_media_creatives` or the exact returned `x_get_media_creative` ID.

Creation supports `PREROLL` and the seven documented TAP image formats. VAST and
unknown formats remain readable but are not authored by this workflow. The ad
group must have native product type `MEDIA`; it and its campaign must be present
and non-draft. X checks native objective, placement and account eligibility.

Native association creation returns `ACTIVE`. Under `paused_creation`, Adport
requires a currently **PAUSED ad group**, even if its campaign is paused. It
preserves parent status, budgets, bids and schedules. Existing budget pools are
reported in micros for policy checks. The native API has no atomic configuration
lock, so context snapshots do not prevent concurrent native changes.

`WEBSITE_CLICKS` requires an explicit `landing_url`. Preroll ignores this field,
so Adport rejects it for preroll instead of silently discarding it. Preroll CTA
settings have [separate guarded tools](x-preroll-ctas.md) and are not changed by
media association creation.
Other display objectives may use native defaults when a URL is omitted.

Context binds the exact source configuration, requested destination, parent
configuration and existing live associations. Native timestamps do not cause
hash changes. Context inventory is limited to ten pages of 200 associations;
missing, repeated or contradictory continuation markers reject creation.
An existing source/ad-group association is not automatically recreated.

## View and remove associations

Both galleries use native cursors with up to 50 rows per page and **Load more**.
Source hydration uses at most four concurrent reads. Missing source access keeps
the association visible with a warning. Previews use only available native HTTPS
media URLs on the known X media CDNs. Missing URLs, deleted or mismatched sources,
and VAST/unknown formats do not produce invented previews or processing claims.
Preroll destinations are not inferred from its ignored `landing_url` field.

The association gallery exposes **Remove from ad group** as a guarded preview.
Alternatively, read `x_get_media_creative`, then preview `x_delete_media_creative`
with its `media_creative_id` and `expected_context_hash`. Apply the same arguments
and pending token after review. Removal retains Account Media, library assets,
posts, other associations and all parent settings. A deleted tombstone can retain
native `entity_status: ACTIVE`; the gallery displays **DISASSOCIATED** separately.

There is no invented PUT pause or in-place source replacement. To replace an ad,
review a new association and the old association's removal separately. This
workflow does not delete the Account Media source or underlying bytes.

Native writes are never retried automatically. Wrong receipts, source or parent
drift, partial native errors and failed readback retain known association IDs for
reconciliation. An error does not prove that nothing was created or removed.

## Scope and verification

This workflow starts with an existing native Account Media ID. It does not infer
an Account Media ID from media-library registration, upload new bytes, publish a
post, edit preroll CTAs or certify source-byte identity. Project-media uploads and
X media-library registration remain separate existing workflows.

Contracts were refreshed on 2026-11-06 from the official
[Account Media reference](https://docs.x.com/x-ads-api/creatives/reference#account-media)
and [Media Creatives reference](https://docs.x.com/x-ads-api/campaign-management/reference#media-creatives),
with source pinned to
[xdevplatform/docs](https://github.com/xdevplatform/docs/tree/09e643bc80f16cfbbee3340db214e682daec4e97).
Contract, policy and synthetic MCP/OpenAI widget tests cover this implementation;
actual Claude/ChatGPT and positive native mutation verification remain pending.
The existing QA grant returned successful empty Account Media, media-creative
and line-item reads. Its account remains rejected; no native association was
created or removed, and populated native galleries remain unverified.

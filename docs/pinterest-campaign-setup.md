# Pinterest campaign hierarchy and creative previews

Pinterest tools use the same registry and preview/apply policy in the CLI, local MCP and hosted MCP. Advertising creation is forced to `PAUSED` by the default policy. Every status, bid, budget, targeting or archive operation requires its own approved preview.

## Campaigns and ad groups

`pinterest_create_campaign` creates a campaign with Campaign Budget Optimization (CBO). Its daily/lifetime cap is an integer amount in account-currency micros. `pinterest_create_ad_group` verifies the parent campaign and keeps CBO budgets at campaign level. An existing non-CBO campaign instead requires a child budget.

Ad-group creation asks for the billable event, bid strategy and geographical targeting. Automatic targeting defaults to false and appears explicitly in the preview. MAX_BID requires a bid. CBO supports STANDARD pacing only. Some CBO scheduling features require Pinterest beta access.

`pinterest_get_entity` reads one verified campaign/ad group/ad by its native ID. `pinterest_ad_groups` and `pinterest_ads` provide paged configuration reads. Native array query parameters use **comma-separated values**: the live endpoint silently treated repeated status parameters as only their final value, causing historical/archived entities to disappear. Reporting and configuration reads share the corrected encoding.

`pinterest_update_ad_group` edits supplied name, schedule, targeting and optimization fields. Omitted targeting dimensions and optimization properties are preserved; supplied arrays replace their previous values. Conversion tags must belong to the selected advertiser. Monetary optimization targets, including native string-valued CPA goals, are included in policy deltas.

`pinterest_set_ad_group_budget` preserves an existing non-CBO daily/lifetime budget type. Use `pinterest_set_budget` for CBO campaigns. `pinterest_set_ad_group_bidding` checks current/proposed bids in micros. Parent and child serving statuses remain independent.

## Ads and Pin content

`pinterest_create_ad` creates a paused ad using an existing eligible Pin and verified advertiser-owned ad group. This does not change the original Pin. `pinterest_update_ad` edits name, destination and tracking fields. Pinterest permits replacing `pin_id` only on DRAFT ads; use a new paused ad for a different Pin after publication.

`pinterest_ads` can hydrate the Pins referenced by the selected advertiser's ads to display their actual copy and image/video media. The connected profile needs existing `boards:read` and `pins:read` permissions. A denied Pin read preserves the ad configuration and reports a warning. Hydration uses up to four concurrent requests and preview pages are capped at50 ads. Disable `include_pin_details` for larger configuration-only pages.

Ad-setting actions stay bound to the displayed advertiser and use the ordinary policy preview/apply gate. Editing a shared original Pin is a separate operation from editing an ad.

## Agent-managed original Pins and media

These named tools use Pinterest's [official v5 OpenAPI](https://github.com/pinterest/api-description/tree/main/v5) (5.28.0); no dashboard or browser upload is required. The existing ads-only OAuth scope is unchanged. Board/Pin operations require the corresponding existing `boards:read`, `boards:write`, `pins:read` and `pins:write` grants plus native Business Access roles. Pin updates also require Pinterest's beta access. A tool being present does not establish those permissions.

Owners can explicitly opt in through **Platforms → Pinterest → Enable Pin management**, or locally with `adport connect pinterest --pin-management`. The option requests the two Ads scopes plus `boards:read`, `boards:write`, `pins:read`, `pins:write` and `user_accounts:read`. Existing connections and ordinary ads-only connect flows are unchanged. The hosted opt-in is bound to its one-use encrypted OAuth transaction; callback query parameters cannot add permissions. The exchange must confirm every requested scope before replacing the stored grant. The app still needs Pinterest access to those scopes; this option does not bypass native app review or beta restrictions. Once authorized, normal asset work uses tools without a dashboard.

1. Use `pinterest_boards` to discover the selected advertiser owner's boards and their current visibility. Collaborator boards are labeled but are not writable through these tools. `pinterest_create_board` creates a `SECRET` board by default. Explicit `PUBLIC` creation requires `confirm_publication`; `PROTECTED` creates an ad-only board named by Pinterest. Protected boards are not secret boards.
2. Stage exact source bytes with the [project media tools](creative-media.md#project-media-library), or use an absolute `file_path` from local CLI/stdio. `pinterest_create_image_pin` resolves the SHA-256-bound PNG/JPEG on the server and sends native `image_base64`; the agent does not reproduce provider base64. Supply `original_content: true`, an owned board ID and its exact `expected_board_privacy`. Public boards require `confirm_publication: true`. This creates original Pin content; creating or enabling an advertiser ad is a separate operation.
3. For video, preview/apply `pinterest_upload_video` with the source and SHA-256. Adport registers the native video and transfers the bytes using Pinterest's signed multipart instructions. OAuth is never forwarded to Storage. Read `pinterest_get_media_upload` using the returned native ID; only `succeeded` media can be used by `pinterest_create_video_pin`. Its cover image uses the selected keyframe in seconds. Native video processing can still reject codecs, duration or other eligibility.

Pinterest's `/media` endpoint is scoped to the credential's user, with no advertiser parameter. Video tools therefore verify the selected advertiser owner against that user and require existing `user_accounts:read` in addition to the media scopes; delegated advertisers with a different owner are rejected. Upload acceptance is separate from processing success. Failed or unknown registration/transfer is not retried; any returned native ID is retained for reconciliation. Pinterest exposes no delete-media endpoint in this contract.

`pinterest_pins` displays original copy/media with bookmark pagination, optionally for one owned board. `pinterest_get_pin` returns a current snapshot and an edit form for an explicitly owned, never-promoted Pin. `pinterest_update_pin` edits only supplied title, description, alternative text or link; `null` clears a field. Source bytes, board membership and delivery are preserved. Shared original content can change its existing organic display. `pinterest_delete_pin` permanently deletes the original after verifying its snapshot. Both operations reject promoted Pins or unknown promotion/ownership state; use a new replacement Pin for those cases. Native copy edits are beta and may be denied for the connected app. A changed copy, board privacy, owner or promotion flag invalidates the snapshot.

These operations are ordinary shared-registry tools: CLI, MCP and hosted REST all use the same preview/apply policy, protected-account checks, one-use approvals and audit log. Additive board/image/video creation is annotated as a write; copy replacement and deletion carry destructive hints. Every mutation still requires preview and apply.

## Discovery and cleanup

`pinterest_targeting_options` returns native targeting choices. `pinterest_audience_estimate` uses a non-binding read-only POST estimate. `pinterest_audiences` and `pinterest_conversion_tags` read existing configuration without uploading customer data, installing tracking or sending events.

`pinterest_archive_entity` verifies ownership and archives a campaign, ad group or ad. Batch failures retain any returned resource IDs for reconciliation before retrying; an incomplete or mismatched receipt is not reported as a successful apply.

## Verification

Live verification covered configuration/discovery/estimate reads, paused CBO campaign and ad-group creation, name/locale/bid/budget changes, rejection of a child budget under CBO, and archive cleanup. Direct resource reads and corrected CSV-filtered lists confirmed the QA resources archived. Real Pin-backed ad creation and Pin media reads require eligible existing Pins and their provider permissions; contract tests do not establish those grants. Original Pin/board/video operations have native-wire and policy tests; existing-connection live results are recorded separately from local verification.

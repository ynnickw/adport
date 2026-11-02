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

Ad-setting actions stay bound to the displayed advertiser and use the ordinary policy preview/apply gate. Editing a shared original Pin is not part of these actions. Original Pin creation/editing and native video upload require additional provider workflows; they are not implied by ad-setting tools or the existing ads-only OAuth scopes.

## Discovery and cleanup

`pinterest_targeting_options` returns native targeting choices. `pinterest_audience_estimate` uses a non-binding read-only POST estimate. `pinterest_audiences` and `pinterest_conversion_tags` read existing configuration without uploading customer data, installing tracking or sending events.

`pinterest_archive_entity` verifies ownership and archives a campaign, ad group or ad. Batch failures retain any returned resource IDs for reconciliation before retrying; an incomplete or mismatched receipt is not reported as a successful apply.

## Verification

Live verification covered configuration/discovery/estimate reads, paused CBO campaign and ad-group creation, name/locale/bid/budget changes, rejection of a child budget under CBO, and archive cleanup. Direct resource reads and corrected CSV-filtered lists confirmed the QA resources archived. Real Pin-backed ad creation and Pin media reads require eligible existing Pins and their provider permissions; contract tests do not establish those grants.

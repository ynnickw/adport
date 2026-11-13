# Snapchat campaign, creative and audience setup

The CLI, local MCP and hosted MCP use the same typed registry. Every mutation requires the normal preview/apply pair with identical arguments, a non-expired token and account policy checks. Snap has no server validation mode for these tools; previews report `serverValidated: false`.

## Campaign hierarchy

Use `snapchat_list_campaigns`, `snapchat_adsquads`, `snapchat_ads` and `snapchat_get_entity` to inspect configuration. Child mutations verify the entire parent chain before sending a write. List tools return native cursor pagination; read subsequent pages with the returned `next_cursor`.

Create a campaign, then an ad squad with explicit targeting, placement and optimization. New campaigns, ad squads and ads are paused by policy; an ACTIVE request reports its PAUSED coercion. The tools check returned IDs, ownership, parent relationships, status and monetary values before reporting applied success. Unexpected receipts preserve returned IDs for reconciliation.

Budget and bid values are integer account-currency micros. An ad squad requires exactly one daily or lifetime budget; a daily budget is at least 5,000,000 micros. Budget updates preserve the existing delivery constraint. Monetary bids participate in the shared current-value policy checks. Deprecated `MIN_ROAS` is excluded. A ROAS ratio would not be a monetary budget delta.

`snapchat_update_targeting` patches supplied dimensions, preserving omitted dimensions and replacing supplied arrays. Multi-country targeting requires a single-language demographic entry. Targeting changes trigger review and can briefly interrupt delivery. `snapchat_targeting_options` returns native country, demographic, device and interest choices; lifestyle categories require a country and support the HCE filter. `snapchat_audience_size` queries the native `audience_size_v2` estimate for an owned ad squad.

Use named status tools to pause/re-enable children. `snapchat_delete_entity` permanently deletes a campaign, ad squad or ad. Review its child hierarchy before deleting a parent; pausing is the reversible delivery operation.

## Media and creative content

1. Find a project file using `media_list`, or calculate the SHA-256 of a local file for CLI/stdio use.
2. Create an IMAGE/VIDEO container using `snapchat_create_media`.
3. Preview `snapchat_upload_media` with the native `snapchat_media_id`, source `media_id` or `file_path`, and `expected_sha256`. Repeat identical arguments with the pending token to upload.
4. Find an already-shared Public Profile ID with `snapchat_public_profiles`.
5. Use `snapchat_create_creative` with READY owned media, the profile and the required attachment fields.
6. Use `snapchat_create_ad` to reference the creative from an owned ad squad. This creates a paused ad and validates native ad/creative format compatibility.

Uploads reject ready containers, wrong media types, foreign accounts and changed checksums. Image uploads accept PNG/JPEG up to 5 MB. Video uploads accept MP4/MOV up to 100 MiB locally, subject to the hosted library’s 50 MiB limit. Files above 32 MB use native INIT/ADD/FINALIZE. Both server-provided paths must match the approved media ID, expected action and Snap origin before any chunk is sent. No mutation is retried automatically. Media readiness and upload receipt state are reported separately from ad delivery. Lens packages are created in Snap’s authoring tools; this uploader does not fabricate a Lens upload API.

`snapchat_creatives` returns actual copy and native image/video previews with account-bound edit actions. Missing media permissions produce a visible warning while retaining copy. The MCP Apps/ChatGPT viewer submits ordinary tool previews; approval and project/account authorization stay on the server.

Creative editing changes **all ads sharing that creative** and triggers review. The preview lists currently linked ad IDs. Copy, CTA and writable attachment fields use partial JSON Patch; omitted fields and server metadata are preserved. CTA compatibility is checked for supported attachment types. Top Snap media replacement is restricted to unused creatives; create a new creative and paused ad for a different image/video on a linked ad. Ad-level creative IDs are immutable through the documented partial-update route.

Creation supports Snap, web, app, deep-link, story preview/composite and lens-attachment creatives. Other specialized formats and authoring flows are not implied by the generic creative gallery. Phone-number verification, Lens Studio authoring, product catalogs and lead-form creation require their own workflows.

## Audience and measurement setup

`snapchat_audiences` and `snapchat_get_audience` inspect segment metadata and readiness, without retrieving individual members. Named create tools support empty customer lists, website events, mobile events, ad engagement, profile engagement and lookalikes. All referenced campaigns, ad squads, profiles, apps and pixels must already be available to the selected account. Mutable audience metadata is preserved during native PUT. Event audiences require historical prefill; ad-engagement retention is 395 days, profile/lookalike retention is at most 180 days. Customer-list 9999 means lifetime retention.

Customer membership tools accept one native schema and up to 10,000 unique lowercase SHA-256 identifiers per call. Normalize identifiers according to Snap’s rules before hashing; raw identifiers are rejected. Preview and audit output contain counts and a payload digest. The private pending-operation store retains the approved arguments for the ordinary 15-minute approval window. Native error messages redact hashes and credentials. Membership updates, clearing and segment deletion can affect existing ads using that audience; deletion and clearing require their own preview/apply pair.

`snapchat_pixels` reads existing account pixels. Snap’s current documentation directs Pixel creation to Ads Manager. `snapchat_rename_pixel` requires actual account ownership; shared foreign pixels cannot be renamed. `snapchat_set_adsquad_measurement` associates existing Pixel/Snap App IDs while preserving other event-source dimensions. These tools do not install tracking code or send conversion events.

Custom-conversion tools read/create typed native Pixel or App rules. Rule value types and operators are validated. Deletion requires an account-owned Pixel source; Snap App definitions are shared resources without proven ad-account ownership, so deletion is rejected under an account-only grant. No sharing-policy mutation or permission expansion is exposed.

## Verification boundary

Contract tests use outgoing requests and current official examples. They cover hierarchy checks, paused receipts, integer micros, policy caps, partial batch errors, shared-copy edits, checksums, chunk URL scope, audience-source ownership, hashed membership counts and custom-conversion rules. These are not live provider tests. Real Snapchat endpoint calls and native Claude/ChatGPT creative widgets remain separate checks requiring the existing Adport account and host grants.

Sources: [ad squads](https://developers.snap.com/marketing-api/Ads-API/ad-squads), [ads](https://developers.snap.com/marketing-api/Ads-API/ads), [creatives](https://developers.snap.com/marketing-api/Ads-API/creatives), [media](https://developers.snap.com/marketing-api/Ads-API/media), [targeting](https://developers.snap.com/marketing-api/Ads-API/targeting), [customer lists](https://developers.snap.com/marketing-api/Ads-API/audience-creation/customer-lists), [website events](https://developers.snap.com/marketing-api/Ads-API/audience-creation/website-events), [mobile events](https://developers.snap.com/marketing-api/Ads-API/audience-creation/mobile-app-events), [ad engagement](https://developers.snap.com/marketing-api/Ads-API/audience-creation/ad-engagement), [profile engagement](https://developers.snap.com/marketing-api/Ads-API/audience-creation/profile-engagement), [lookalikes](https://developers.snap.com/marketing-api/Ads-API/audience-creation/lookalikes), [Snap Pixel](https://developers.snap.com/marketing-api/Ads-API/snap-pixel), [custom conversions](https://developers.snap.com/marketing-api/Ads-API/custom-conversions) and [shared-profile discovery](https://developers.snap.com/marketing-api/Public-Profile-API/ProfileAssetManagement#list-sharing-policies). Reviewed 2026-11-03.

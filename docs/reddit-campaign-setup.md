# Reddit campaign children and creatives

The CLI, stdio MCP and hosted MCP share one tool registry. All mutations use the same preview/apply gate, exact arguments, expiring pending tokens, account policy and audit log. Reddit has no server dry-run mode for these operations. A local preview is not evidence that the provider will accept a request.

## Campaign and child configuration

Read campaigns with `reddit_campaigns`, child configuration with `reddit_ad_groups`/`reddit_ads`, and an exact resource with `reddit_get_entity`. Child mutations verify the full campaign/ad-group/ad hierarchy. Native list URLs are returned as `next_cursor` and followed within the same resource path. Targeting endpoints without native pagination report truncation and require narrower filters.

New campaigns, ad groups and ads are paused by policy. Current v3 campaign objectives are validated; `CLICKS` is the default. `reddit_create_ad_group` handles manual campaigns, including CBO inheritance through native null settings. Non-CBO groups require explicit budgets and bids. Targeting expansion defaults off for new groups and is visible in the preview.

Budget and bid values are integer account-currency micros. Updates read current values before policy checks. CBO child budgets/bids belong to the campaign; campaign budget type is immutable. The bidding tool rejects removal of an existing monetary cap because the current policy model cannot represent an unbounded change as a numeric decrease.

Targeting updates replace supplied arrays and preserve omitted dimensions. Referenced audiences must already be available to the account. Unsupported current targeting fields cause a rejection rather than a partial update that could reset them. Native targeting discovery covers geolocations, communities/search, interests, languages, carriers, devices and third-party audiences.

Use the child status tools to pause/re-enable delivery. `reddit_archive_entity` uses native PATCH for campaigns, groups and ads; it does not invent an unsupported DELETE route. Returned IDs, account, status, money, requested dates and targeting are checked before reporting applied success.

## Asset library and media import

Reddit’s current asset API fetches media from URLs. It does not accept a multipart file upload through this route.

1. Read profiles already associated with the account using `reddit_profiles`.
2. Find a project file and checksum using `media_list`.
3. Preview `reddit_upload_asset` with the profile, type/name, project `media_id` and `expected_sha256`.
4. Repeat identical arguments with its pending token to apply. Only then does Adport issue a one-hour private source URL for Reddit, after rechecking immutable bytes and write access. The preview does not expose that URL.
5. Poll `reddit_asset_upload_status` using the returned upload ID and `resource_receipt`. An accepted upload can still fail processing. `DUPLICATE_ASSET` can refer to an existing asset; it is not evidence of a newly created resource and must not trigger automatic deletion.

Project storage is private and checksum-bound. Hosted uploads use project media IDs, not server file paths. Native video imports also need an approved poster image. The library’s 50 MiB limit applies, along with Reddit’s own media specifications.

The optional media-resolver capability supports immutable provider fetches. A default local filesystem resolver cannot expose local files to Reddit’s servers. Local CLI users can use `reddit_import_asset_url` with an existing externally accessible HTTPS URL. That tool approves the URL rather than immutable remote bytes and does not fetch the file through Adport. Prefer project media for exact files. `reddit_create_text_asset` submits native headline/CTA assets without a file.

`reddit_assets` renders native image/video/headline/CTA library items and readiness. Profile IDs and Reddit author IDs are resolved through the account association list. Renaming/deleting affects the shared profile library and requires a separate preview/apply pair; inspect its shared usage before approving deletion.

## Structured posts and creative editing

The implementation uses `profiles/{profile_id}/structured_posts/jobs`. The legacy post-creation endpoint is deprecated and removed in v4. Standard authoring supports text, image, video and carousel posts using ready assets from an associated profile. Comments default off. Creating a post does not create or activate an ad.

Native post and asset-processing status responses omit ownership while processing. Their read tools therefore require an account/profile/job-bound, signed `resource_receipt` issued by the approved creation request. It lasts 24 hours and does not replace current account authorization. The profile association is checked again before fetching status. Arbitrary global job IDs and cross-account receipts are rejected. If the app secret rotates, old receipts become invalid.

After a post job succeeds, `reddit_posts` provides a visual review of the associated profile’s posts, including unattached content. `reddit_ads` displays actual referenced copy/media and bound edit actions. Missing post access yields a warning while preserving the ad configuration. Read-only connections keep the viewer without edit forms.

The widget’s copy action uses `reddit_stage_post_copy`: it verifies the selected ad still references the source post, then stages a new post with the supplied headline/body edits. Original media, comments and other supported creative settings are retained. Original posts and ad references remain unchanged. Unsupported formats or fields are rejected rather than silently omitted. Multiline body text is preserved through the host bridge.

Poll `reddit_post_job`, review the result, then use a separate `reddit_update_ad` approval to attach its post ID to one selected ad. Replacement preserves configured delivery status and can trigger review. `reddit_create_ad` creates a paused ad instead. Existing posts shared across ads are not edited in place by this workflow.

## Reports and verification

Report pages repeat the original POST body and remain account-scoped. Spend/bid/budget fields use micros; `CONVERSION*TOTAL_VALUE` report fields use cents. Missing conversions remain unavailable, ratios are calculated only from available inputs, and truncation is explicit.

Wire tests cover native envelopes, CBO inheritance, paused receipts, current monetary policy checks, hierarchy/source ownership, raw-tool guard compatibility, account-bound async receipts, immutable media sources, structured-post copies and native URL pagination. Local storage integration checks exercise source bytes, write access and cross-project denial. DOM tests verify the multiline edit payload and preview-only host-bridge submission.

Existing authorized MCP campaign/report reads and a no-change paused-status preview have succeeded on a real account. The new child/creative flows need their own live endpoint verification. Native Claude and ChatGPT widget execution is separate from tool discovery. Reddit Max, advanced audience/measurement setup, catalog workflows and other specialized formats require their own implementation and checks; this is not full API coverage.

Source: [official current Reddit v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json), fetched 2026-11-03.

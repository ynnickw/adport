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

## Audiences and measurement

`reddit_audiences`/`reddit_get_audience` show native availability, ownership and readiness. Named creation supports empty customer lists, Pixel retargeting and campaign-engagement retargeting. Pixel sources must be available to the account; engagement campaigns must belong to it. Current v3 exposes lookalikes for reading, without a documented creation route here. It also has no custom-audience rename/update endpoint.

Membership changes use native PATCH, with up to 2,500 rows and explicit `EMAIL_SHA256`/`MAID_SHA256` column order. Rows must contain lowercase SHA-256 values, match the columns and be unique. Mutations require account ownership and a directly managed customer list. Read access to a shared or external-provider audience does not grant direct membership editing or deletion. Previews and audit summaries contain counts and a payload digest; identifiers remain in the private expiring pending operation. Deleting a custom audience is permanent and can affect targeting.

Saved audiences have their own list/get/create/update/delete tools. Updates merge supplied dimensions and preserve omitted targeting, reject unknown current dimensions, and validate referenced custom audiences. Creation makes expansion explicitly false unless supplied. Native deletion is PATCH `status: DELETED`. Previews include the reported number of active ad groups using the shared saved audience.

`reddit_pixels` lists account-available Pixels and `reddit_pixel_last_fired` reports native activity timestamps. Current public v3 documents reading Pixels, without a Pixel creation/rename route. Configure those in Events Manager.

`reddit_send_conversion_events` requires the connection’s existing `adsconversions` permission; ordinary `adsread`/`adsedit` access is insufficient. This implementation does not request broader OAuth permissions or generate a conversion token. TEST mode needs an Events Manager `test_id`. LIVE mode must be explicit and submits real measurement data, which can affect attribution and optimization. Keep fabricated QA events in TEST mode. Native API acceptance does not prove final processing or attribution.

Events use Unix milliseconds, native uppercase v3 tracking types and base-currency revenue values, separate from advertising budget micros. Every event needs a stable `metadata.conversion_id` for deduplication. Adport requires pre-hashed customer match keys; follow Reddit’s normalization rules before hashing. Source URLs, match keys and event IDs are omitted from previews. Payloads are not automatically retried. Reddit requires events within seven days of occurrence. [Business catalogs](providers/reddit-catalogs.md) have separate exact-resource grants and guarded configuration tools; [product views, sets and import diagnostics](providers/reddit-catalog-content.md) and [feeds](providers/reddit-catalog-feeds.md) use those grants. Data-deletion jobs and manual product mutations remain outstanding.

## Reports and verification

Report pages repeat the original POST body and remain account-scoped. Spend/bid/budget fields use micros; `CONVERSION*TOTAL_VALUE` report fields use cents. Missing conversions remain unavailable, ratios are calculated only from available inputs, and truncation is explicit.

Wire tests cover native envelopes, CBO inheritance, paused receipts, current monetary policy checks, hierarchy/source ownership, raw-tool guard compatibility, account-bound async receipts, immutable media sources, structured-post copies and native URL pagination. Local storage integration checks exercise source bytes, write access and cross-project denial. DOM tests verify the multiline edit payload and preview-only host-bridge submission.

Existing authorized MCP campaign/report reads and a no-change paused-status preview have succeeded on a real account. The new child/creative/audience/measurement/catalog flows need their own live endpoint verification. No customer list or fabricated LIVE conversion has been uploaded for QA. Native Claude and ChatGPT widget execution is separate from tool discovery. Reddit Max, data-deletion jobs, manual catalog product mutations and other specialized formats require their own implementation and checks; this is not full API coverage.

Source: [official current Reddit v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json), fetched 2026-11-03.

Measurement references: [official CAPI direct integration](https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration) and [customer match keys](https://business.reddithelp.com/articles/Knowledge/about-match-keys).

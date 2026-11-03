# Creative media and editing

Advertising writes use the same tool registry and two-step policy gate in the CLI, local MCP and hosted MCP. A widget edit prepares an ordinary tool preview. Applying that preview uses the original arguments and pending operation token. Account protection, account access, paused creation, budget limits and audit logging still apply.

## Project media library

In Adport Cloud, open **Creative media** in the dashboard, or call `media_list` and open its `upload_page_url`. Uploads are private to the selected project. The upload screen names the destination project, including when opened from another project's assistant conversation.

The upload process reserves a random object path, signs an upload grant with overwrite disabled, verifies the exact size and SHA-256, and fully decodes images before making previews available. Image, video and audio uploads are capped at 50 MiB in the hosted app; provider limits may be lower. Video/audio container acceptance and processing are checked by the advertising provider when uploaded there. Staging a file does not publish an ad.

`media_list` returns the immutable media ID, SHA-256, media type, size, image dimensions when available, and temporary preview URLs. Use the ID and hash in a supported provider upload:

```json
{
  "account_id": "YOUR_AD_ACCOUNT",
  "media_id": "PROJECT_MEDIA_UUID",
  "expected_sha256": "SHA256_FROM_MEDIA_LIST"
}
```

Call `meta_upload_image`, `meta_upload_video`, `tiktok_upload_image`, `tiktok_upload_video`, `spotify_upload_asset`, `snapchat_upload_media` or `apple_upload_asset` without a pending token to preview. Review the preview, then repeat the same arguments with its `pending_operation_id` to upload. Apple additionally requires a Business Brand promoted-object ID; Spotify and Snapchat require a new account-owned media container ID. The provider rechecks the media bytes at both stages.

Local CLI/stdio uploads accept an absolute `file_path` and `expected_sha256` instead of `media_id`. Hosted calls reject local file paths. Files are read through one bounded file handle, symbolic links are rejected, and changing file bytes invalidates the approval.

The library supports images, video and audio previews. Previews expire after 15 minutes. Use the native widget’s **Refresh previews** control or call `media_list` again. The control reuses the same read tool and preserves its project, account, filters and page cursor. Verified hosted files show READY with readable file sizes/dimensions; exact checksums remain in the structured asset data for provider uploads. Abandoned uploads are cleared on subsequent uploads after their signed grants expire. Project deletion queues private media removal after three hours, and the authenticated hourly cleanup job retries failures. The delay prevents an outstanding two-hour upload grant from recreating a file after cleanup.

## Creative tools

Google's `google_ads` reads real ad copy and serving status. `google_update_responsive_search_ad` edits supplied fields, preserves positional pinning and leaves serving status unchanged. `google_set_ad_status` changes the ad-level status independently of its parent ad group and campaign.

Meta's `meta_list_ads` and `meta_list_creatives` return creative content and configuration with visual actions. Meta creative content is immutable: create a replacement with `meta_create_link_creative` or `meta_create_creative`, then attach its ID with `meta_update_ad`. Creating a creative does not replace an existing ad. `meta_create_ad` creates an account-owned ad and respects paused creation. Replacing an active ad's creative preserves its serving status and can trigger review; the preview reports that state.

Meta also exposes ad-set configuration reads, targeting search and estimates, targeting and bidding updates, media library reads/uploads, empty customer-audience creation and pixel creation. Creating a pixel does not install tracking code or send events. Creating an empty audience does not upload customer data. Creative and image deletion are permanent and require their own preview/apply pair.

Apple ad-group, keyword and ad statuses can be changed with their named status tools. Parent delivery settings remain independent.

Spotify's `spotify_ads` and `spotify_assets` render copy and image/video/audio previews. Published ads can stage a draft; draft cards edit copy through the ordinary preview/apply gate. Hierarchy validation and version-bound publication remain separate operations. See [Spotify campaign drafts and media](spotify-campaign-setup.md) for setup, native field semantics and cleanup limits.

Pinterest's `pinterest_ads` reads account ad settings and hydrates only their referenced Pins when the existing connection has boards/pins read access. Its visual actions edit advertiser ad settings through the shared gate. Original shared Pins remain unchanged. See [Pinterest campaign setup](pinterest-campaign-setup.md) for CBO budgets, targeting, native filter encoding and Pin-permission limits.

Snapchat's `snapchat_creatives` displays native copy and image/video media. Copy edits affect all linked ads and trigger review; previews enumerate those ads. Top Snap replacement is restricted to unused creatives. Its media uploader binds the exact file checksum and validates native chunk paths against the approved media ID. See [Snapchat campaign setup](snapchat-campaign-setup.md) for child workflows, audiences and measurement constraints.

Reddit's `reddit_ads`, `reddit_posts` and `reddit_assets` render native copy/media and processing readiness. Its edit action stages a new post copy; attaching that post to an ad is a separate approval. Exact project files use a checksum-checked private provider source because Reddit fetches media by URL. See [Reddit campaign setup](reddit-campaign-setup.md) for async receipts, profile scope and native import semantics.

LinkedIn's `linkedin_creatives` displays actual text-ad copy and referenced images with bound copy/name/status actions. Activation requires explicit advertiser confirmation through the named status tool. Copy edits preserve omitted fields and verify readback. Referenced sponsored posts remain identified as references when source content is unavailable under the pinned API version. See [LinkedIn setup](providers/linkedin.md) for format and permission limits.

X's `x_draft_tweets` and `x_media_library` show native draft copy and image/GIF/video media. Bound copy/name actions request guarded previews; draft edits preserve omitted attachments and never publish a post. Library metadata is separate from ad delivery. SHA-bound native uploads and library registration are separate guarded steps, with account-bound receipts for asynchronous processing. See [X setup](providers/x.md) for author/composer permissions, native draft deletion and the ACTIVE-only promoted-post association constraint.

Microsoft exposes named ad-group, keyword and responsive search ad workflows, including status changes and partial copy/bid updates. Ad-group creation asks for an explicit language. Reads request the optional `AdGroupType` field to verify RSA compatibility. RSA updates retain positional pinning and omit read-only text-asset IDs. Batch failures report successful resource IDs so callers can reconcile partially applied requests before retrying.

Microsoft's normalized `report` supports account, campaign, ad-group and ad levels. `microsoft_keyword_report` and `microsoft_search_term_report` return native CSV fields as strings, including empty or suppressed values. Account ratios use spend/revenue totals even when a caller requests only ROAS. Missing conversion or revenue data is kept unavailable.

The MCP creative viewer uses the standard MCP Apps bridge or the available ChatGPT bridge. It renders provider content without executing it and keeps account/project identifiers bound to the action. Read-only connections receive a viewer without edit forms. Resource CSP permits the configured private Storage origin and supported provider CDNs; tool calls use the host bridge. Host-specific origins use the standard UI metadata; the OpenAI origin alias is included only for HTTPS origins and never contradicts a Claude sandbox domain. Breaking widget revisions use a new resource URI so hosts can refresh cached HTML. The previous URI remains readable for cached descriptors. Confirmed apply results show returned resource IDs and share scoped outcome facts through supported host context, including async receipts when needed for follow-up reads. Consumed apply tokens are omitted. Host echoes of an earlier result cannot replace a newer local edit or confirmed outcome.

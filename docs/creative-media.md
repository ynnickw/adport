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

Call `meta_upload_image`, `meta_upload_video`, `tiktok_upload_image`, `tiktok_upload_video`, `spotify_upload_asset` or `apple_upload_asset` without a pending token to preview. Review the preview, then repeat the same arguments with its `pending_operation_id` to upload. Apple additionally requires a Business Brand promoted-object ID; Spotify requires a new account-owned asset metadata ID. The provider rechecks the media bytes at both stages.

Local CLI/stdio uploads accept an absolute `file_path` and `expected_sha256` instead of `media_id`. Hosted calls reject local file paths. Files are read through one bounded file handle, symbolic links are rejected, and changing file bytes invalidates the approval.

The library supports images, video and audio previews. Previews expire after 15 minutes; call `media_list` again to refresh them. Abandoned uploads are cleared on subsequent uploads after their signed grants expire. Project deletion queues private media removal after three hours, and the authenticated hourly cleanup job retries failures. The delay prevents an outstanding two-hour upload grant from recreating a file after cleanup.

## Creative tools

Google's `google_ads` reads real ad copy and serving status. `google_update_responsive_search_ad` edits supplied fields, preserves positional pinning and leaves serving status unchanged. `google_set_ad_status` changes the ad-level status independently of its parent ad group and campaign.

Meta's `meta_list_ads` and `meta_list_creatives` return creative content and configuration with visual actions. Meta creative content is immutable: create a replacement with `meta_create_link_creative` or `meta_create_creative`, then attach its ID with `meta_update_ad`. Creating a creative does not replace an existing ad. `meta_create_ad` creates an account-owned ad and respects paused creation. Replacing an active ad's creative preserves its serving status and can trigger review; the preview reports that state.

Meta also exposes ad-set configuration reads, targeting search and estimates, targeting and bidding updates, media library reads/uploads, empty customer-audience creation and pixel creation. Creating a pixel does not install tracking code or send events. Creating an empty audience does not upload customer data. Creative and image deletion are permanent and require their own preview/apply pair.

Apple ad-group, keyword and ad statuses can be changed with their named status tools. Parent delivery settings remain independent.

Spotify's `spotify_ads` and `spotify_assets` render copy and image/video/audio previews. Published ads can stage a draft; draft cards edit copy through the ordinary preview/apply gate. Hierarchy validation and version-bound publication remain separate operations. See [Spotify campaign drafts and media](spotify-campaign-setup.md) for setup, native field semantics and cleanup limits.

Microsoft exposes named ad-group, keyword and responsive search ad workflows, including status changes and partial copy/bid updates. Ad-group creation asks for an explicit language. Reads request the optional `AdGroupType` field to verify RSA compatibility. RSA updates retain positional pinning and omit read-only text-asset IDs. Batch failures report successful resource IDs so callers can reconcile partially applied requests before retrying.

Microsoft's normalized `report` supports account, campaign, ad-group and ad levels. `microsoft_keyword_report` and `microsoft_search_term_report` return native CSV fields as strings, including empty or suppressed values. Account ratios use spend/revenue totals even when a caller requests only ROAS. Missing conversion or revenue data is kept unavailable.

The MCP creative viewer uses the standard MCP Apps bridge or the available ChatGPT bridge. It renders provider content without executing it and keeps account/project identifiers bound to the action. Read-only connections receive a viewer without edit forms. Resource CSP permits the configured private Storage origin and supported provider CDNs; tool calls use the host bridge.

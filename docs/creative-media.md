# Creative media and editing

Advertising writes use the same tool registry and two-step policy gate in the CLI, local MCP and hosted MCP. A widget edit prepares an ordinary tool preview. Applying that preview uses the original arguments and pending operation token. Account protection, account access, paused creation, budget limits and audit logging still apply.

## Project media library

Agents can upload, download, inspect, rename and delete private project media through MCP or the tool REST API without opening a dashboard. Images, video, audio and PDF sources are supported. The same project authorization and two-step policy gate apply to media mutations. A hosted server cannot read a file on the agent's computer or in its container; the agent transfers the bytes instead.

In a host that supports ChatGPT file parameters, pass the attached file directly to `media_inspect_file`. The host supplies its file reference; the server downloads the bytes, detects the actual media type, decodes images, and returns exact size and SHA-256 without storing a project asset. Preview and apply `media_import_file` with that same `file` object and the returned metadata. The import verifies the approved bytes again, stores a private immutable source, and returns its ready media ID. This supports files up to 50 MiB without base64, a separate HTTP client or a dashboard. It does not upload to an advertising account. The native attachment handoff uses [OpenAI's file parameter contract](https://developers.openai.com/plugins/reference#define-file-inputs); server downloads accept only direct HTTPS `files.oaiusercontent.com` capabilities, with no forwarded credentials or redirects. A changed checksum or expired download requires a fresh inspection and preview. Other hosts are not assumed to implement this extension. Native ChatGPT execution remains unverified while that connection's tool refresh fails; local tests cover the attachment schema, exact-byte import and project/policy boundaries.

For files up to 1 MiB, preview and apply `media_upload` with `name`, `content_type`, `byte_length`, `sha256` and canonical `data_base64`. The applied result includes a ready `result.details.media_id` and SHA-256 for provider uploads. For files up to 50 MiB:

1. Preview and apply `media_prepare_upload` with the file's name, MIME type, exact byte length and SHA-256.
2. Send the raw bytes using HTTP `PUT` to `result.details.upload_url` with the returned headers. This temporary storage capability does not require a dashboard or an Adport API key in the upload request.
3. Preview and apply `media_finalize_upload` with the returned `media_id` and `expected_sha256`. The file becomes available after its bytes have been verified.

When the agent has file access but cannot make HTTP uploads, it can transfer the file entirely through MCP. After `media_prepare_upload`, use its `mcp_upload` plan: split the original bytes into 1 MiB parts, with only the final part shorter. Preview and apply `media_upload_part` for each zero-based `part_index`, supplying `media_id`, the reserved `expected_sha256`, that part's `part_sha256`, and canonical `data_base64`. Parts may arrive out of order and cannot be overwritten. `media_get` reports received part indexes and lengths; reconcile an unknown outcome before requesting another preview. Then preview/apply `media_finalize_upload`. Finalization assembles the parts in order, verifies the exact whole-file size, MIME and checksum, removes temporary parts, and marks the file ready. It does not upload to an advertising provider. This path needs no browser, dashboard, external HTTP request or additional credential from the agent. Base64 tool arguments are larger than raw bytes, so use the raw PUT path when the agent supports it.

The host must be able to send the file bytes into a tool call programmatically. A file attached to a Claude conversation is not automatically readable by a remote MCP server. If the host requires the model to reproduce base64 arguments, large video transfers may be impractical even though Adport accepts them. Use the CLI or the signed HTTP upload from an agent with file and network access in that case; do not assume a model-carried transfer has succeeded. The native Claude test verified a small PDF through MCP, while the 4.9 MB video remained untransferred because the host could not inject its file bytes into the tool calls.

`media_get` returns processing/deletion status, metadata and a temporary `asset.preview_url` for downloading ready files. `media_rename` and `media_delete` require the file's current `expected_name` and immutable `expected_sha256`. Rename changes metadata; delete removes the project source and blocks reuse. Provider copies, ads and campaigns are independent. To replace the file's content, upload a new immutable file and select its new ID.

The CLI can transfer a local file and finalize it with a project-scoped API key. The first command previews; repeat it with the returned pending operation ID to apply:

```sh
adport media upload ./creative.mp4 --api-key-env ADPORT_API_KEY
adport media upload ./creative.mp4 --api-key-env ADPORT_API_KEY --pending-operation-id <id-from-preview>
```

See [agent-managed project media](providers.md#agent-managed-project-media) for the REST/CLI workflow. The dashboard's **Creative media** screen and `media_list`'s `upload_page_url` remain optional ways for people to upload files; agents can use the tools directly.

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

The library supports images, video and audio previews. PDF sources return download links through `media_get`; they are not played as audio or embedded as executable content. Previews expire after 15 minutes. Use the native widget’s **Refresh previews** control or call `media_list` again. The control reuses the same read tool and preserves its project, account, filters and page cursor. Verified hosted files show READY with readable file sizes/dimensions; exact checksums remain in the structured asset data for provider uploads. Abandoned uploads are cleared on subsequent uploads after their signed grants expire. Project deletion queues private media removal after three hours, and the authenticated hourly cleanup job retries failures. The delay prevents an outstanding two-hour upload grant from recreating a file after cleanup.

## Creative tools

Google's `google_ads` reads real ad copy and serving status. `google_update_responsive_search_ad` edits supplied fields, preserves positional pinning and leaves serving status unchanged. `google_set_ad_status` changes the ad-level status independently of its parent ad group and campaign.

Meta's `meta_list_ads` and `meta_list_creatives` return creative content and configuration with visual actions. Meta creative content is immutable: create a replacement with `meta_create_link_creative` or `meta_create_creative`, then attach its ID with `meta_update_ad`. Creating a creative does not replace an existing ad. `meta_create_ad` creates an account-owned ad and respects paused creation. Replacing an active ad's creative preserves its serving status and can trigger review; the preview reports that state.

Meta also exposes ad-set configuration reads, targeting search and estimates, targeting and bidding updates, media library reads/uploads, audience configuration and pixel creation. Audience tools cover empty customer containers, metadata edits, usage checks, guarded deletion, URL-based website rules and lookalikes; see [Meta audiences](providers/meta-audiences.md) for snapshots and native permission limits. Creating a pixel does not install tracking code or send events. Creating an empty audience does not upload customer data. Creative and image deletion are permanent and require their own preview/apply pair.

Apple ad-group, keyword and ad statuses can be changed with their named status tools. Parent delivery settings remain independent.

Spotify's `spotify_ads` and `spotify_assets` render copy and image/video/audio previews. Published ads can stage a draft; draft cards edit copy through the ordinary preview/apply gate. Hierarchy validation and version-bound publication remain separate operations. See [Spotify campaign drafts and media](spotify-campaign-setup.md) for setup, native field semantics and cleanup limits.

Pinterest's `pinterest_ads` reads account ad settings and hydrates only their referenced Pins when the existing connection has boards/pins read access. Its visual actions edit advertiser ad settings through the shared gate. Original Pins have separate `pinterest_boards`, `pinterest_pins` and `pinterest_get_pin` workflows. Agents can create boards, upload exact image/video sources, create original Pins, edit copy and delete an owned never-promoted Pin without a dashboard. Pin edits use snapshot-bound preview/apply; public creation needs explicit confirmation. Existing OAuth scopes and native app access still apply. See [Pinterest campaign setup](pinterest-campaign-setup.md) for media processing, visibility, ownership and permission limits.

Snapchat's `snapchat_creatives` displays native copy and image/video media. Copy edits affect all linked ads and trigger review; previews enumerate those ads. Top Snap replacement is restricted to unused creatives. Its media uploader binds the exact file checksum and validates native chunk paths against the approved media ID. See [Snapchat campaign setup](snapchat-campaign-setup.md) for child workflows, audiences and measurement constraints.

Reddit's `reddit_ads`, `reddit_posts` and `reddit_assets` render native copy/media and processing readiness. Its edit action stages a new post copy; attaching that post to an ad is a separate approval. Exact project files use a checksum-checked private provider source because Reddit fetches media by URL. See [Reddit campaign setup](reddit-campaign-setup.md) for async receipts, profile scope and native import semantics.

LinkedIn's `linkedin_creatives` displays actual text-ad copy and images, and hydrates sponsored creatives through native descriptive metadata when available. `linkedin_get_sponsored_post` reads source copy and ordered carousel media with the required Page permissions; account-owned dark posts receive shared-copy edit forms. Image, video and PDF uploads, metadata management, paused sponsored-ad creation and existing-post reuse have named guarded tools. New inline dark posts remain URL-accessible despite having no organic feed distribution; previews disclose this before apply. Activation requires explicit advertiser confirmation through the named status tool. Copy edits preserve omitted fields and verify exact resource readback. See [LinkedIn setup](providers/linkedin.md) for format, ownership and permission limits.

X's `x_draft_tweets` and `x_media_library` show native draft copy and image/GIF/video media. Bound copy/name actions request guarded previews; draft edits preserve omitted attachments and never publish a post. Library metadata is separate from ad delivery. SHA-bound native uploads and library registration are separate guarded steps, with account-bound receipts for asynchronous processing. See [X setup](providers/x.md) for author/composer permissions, native draft deletion and the ACTIVE-only promoted-post association constraint.

Microsoft exposes named ad-group, keyword and responsive search ad workflows, including status changes and partial copy/bid updates. Ad-group creation asks for an explicit language. Reads request the optional `AdGroupType` field to verify RSA compatibility. RSA updates retain positional pinning and omit read-only text-asset IDs. Batch failures report successful resource IDs so callers can reconcile partially applied requests before retrying.

Microsoft image galleries and SHA-bound uploads use account-owned source media. Callout, Sitelink, StructuredSnippet and Image extensions have separate guarded create/edit/link/unlink operations. Image extension alternative text can be edited through its native widget with an explicit before/after review; source-image text is separate. See [Microsoft workflows](providers/microsoft.md) for ownership, association safety, targeting, direct exclusions and shared daily budgets.

Microsoft's normalized `report` supports account, campaign, ad-group and ad levels. `microsoft_keyword_report` and `microsoft_search_term_report` return native CSV fields as strings, including empty or suppressed values. Account ratios use spend/revenue totals even when a caller requests only ROAS. Missing conversion or revenue data is kept unavailable.

The MCP creative viewer uses the standard MCP Apps bridge or the available ChatGPT bridge. It renders provider content without executing it and keeps account/project identifiers bound to the action. Read-only connections receive a viewer without edit forms. Resource CSP permits the configured private Storage origin and supported provider CDNs; tool calls use the host bridge. Host-specific origins use the standard UI metadata; the OpenAI origin alias is included only for HTTPS origins and never contradicts a Claude sandbox domain. Breaking widget revisions use a new resource URI so hosts can refresh cached HTML. The previous URI remains readable for cached descriptors. Confirmed apply results show returned resource IDs and share scoped outcome facts through supported host context, including async receipts when needed for follow-up reads. Consumed apply tokens are omitted. Host echoes of an earlier result cannot replace a newer local edit or confirmed outcome.

Read-only planning tools can declare the shared `planning` presentation. Native decimal strings, uncertainty bounds and unit labels are rendered as escaped table cells, with unavailable values shown explicitly. Large tables page locally in groups of100 rows; this neither calls a provider again nor creates an approval. LinkedIn bid/budget pricing and supply forecasts use this view. The version7 widget resource adds planning tables while keeping previous resource URIs readable.

Gallery tools can declare their native continuation field in the shared tool definition. The MCP adapter validates the continuation against that same input schema and supplies a read-only **Next page** action. It preserves the current account, project, filters and page size; refreshing then reloads the displayed page. Invalid or unchanged cursors do not produce a continuation action. Project media, Google assets, Reddit, Pinterest, Snapchat, Spotify, LinkedIn and X galleries expose this action where their native responses provide a continuation.

`google_assets` orders shared assets by native asset ID. Pass its returned `next_cursor` as `after_asset_id`, retaining the same filters and limit. IDs remain decimal strings, including values beyond JavaScript’s safe integer range. This is a continuation through current account data, not a frozen snapshot.

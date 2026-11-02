# TikTok campaign and creative workflows

The CLI and MCP server use the same core tool definitions. All advertising writes require a preview, followed by identical arguments plus the returned `pending_operation_id`. TikTok provides no server validation-only mode: previews read current configuration and produce local plans. `DISABLE` is TikTok's paused status; creation policy applies to each ad-group/ad creative, including omitted default statuses on generic creates.

| Workflow | Tools | Native API |
| --- | --- | --- |
| Inspect child configuration | `tiktok_ad_groups`, `tiktok_ads` | `GET adgroup/get`, `GET ad/get`; native configuration and page metadata remain visible. |
| Create an ad group | `tiktok_create_ad_group` | `POST adgroup/create`; explicit objective-dependent placement, promotion, optimization, budget, bidding and advertiser-time schedule. Targeting fields are flattened into the native request. |
| Create standard or Spark ads | `tiktok_create_ads` | `POST ad/create`; up to20 creatives, each forced paused when policy requires it. Select existing authorized identity and media IDs first. |
| Change child status | `tiktok_set_ad_group_status`, `tiktok_set_ad_status` | Separate `adgroup/status/update` and `ad/status/update` endpoints. Every requested ID is checked in the advertiser before submission. |
| Edit copy/media | `tiktok_update_ad` | `POST ad/update` with `patch_update:true` and native `creatives`. Omitted creative fields and serving status stay unchanged. |
| Change targeting | `tiktok_update_targeting` | `POST adgroup/update`; only supplied dimensions replace their existing arrays. |
| Change child money/ROAS | `tiktok_set_ad_group_budget`, `tiktok_set_ad_group_bidding` | Current monetary values are fetched and checked in micros. ROAS remains a ratio. Unknown current amounts reject the preview. |
| Select identity | `tiktok_identities` | `GET identity/get`; lists existing authorized identities without granting access. |
| Inspect media | `tiktok_videos`, `tiktok_image_info`, `tiktok_video_info` | Video library search and image/video metadata endpoints. Provider-returned media URLs are preserved. |
| Upload media | `tiktok_upload_image`, `tiktok_upload_video` | Multipart `file/{image,video}/ad/upload` with native MD5 signatures. SHA-256 binds the approved bytes to preview/apply. |
| Inspect audiences/pixels | `tiktok_custom_audiences`, `tiktok_saved_audiences`, `tiktok_pixels` | Native advertiser-scoped list endpoints; no customer data or tracking events are uploaded. |
| Find location targeting | `tiktok_search_targeting` | Read-only `POST tool/targeting/search`. Explicit objective/placement; promotion type is needed for some objectives. |

Use [`media_list` and the project asset library](creative-media.md) to upload files for hosted tools. Hosted runtimes accept scoped immutable `media_id` values; local CLI/stdio can use an absolute `file_path`. Adport's current provider upload caps are10MiB for images and100MiB for videos; the hosted staging cap may be smaller. Media formats, dimensions, identity eligibility, objective combinations and account limits are additionally validated by TikTok.

Ad cards display native text, destination and available preview URLs. Their edit/status actions bind the advertiser and entity IDs, request a new policy preview and use the ordinary approval flow. Spark text can come from its source post, so its card omits the ad-copy text form. Creating a standard ad does not grant Spark authorization or create an identity.

Wire contracts are tested against the [official SDK at f809c396](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3), including `adgroup_create_body.py`, `ad_update_body.py`, child status bodies, `file_api.py` multipart fields and the targeting OpenAPI definitions. Tests check headers, trailing slashes, JSON parameters, payload masks, monetary conversion, parent/account validation and changed-byte rejection. This extension has not yet been verified through the existing hosted TikTok grant; live verification and additional audience/measurement/automation workflows remain pending.

# TikTok catalog videos

Catalog videos belong to a Business Center catalog. They are separate from
advertiser creative-library videos and can feed existing Video Shopping Ads.
Adport requires the exact project, advertiser, Business Center and catalog grant
used by the [catalog workflows](tiktok.md#project-scoped-catalog-access).
Only single-country E-commerce catalogs are documented as eligible. Known
multi-country catalogs and other catalog types are rejected; a missing native
multi-country flag remains unknown, with final eligibility enforced by TikTok.

| Tool | Native v1.3 operation |
| --- | --- |
| `tiktok_catalog_videos` | `GET /catalog/video/get/` |
| `tiktok_catalog_video_import_context` | Checksum-bound Adport CSV read plus `GET /catalog/product/get/` for every selected SKU |
| `tiktok_upload_catalog_videos` | `POST /catalog/video/file/`, followed by an exact job read |
| `tiktok_catalog_video_log` | `GET /catalog/video/log/` |
| `tiktok_delete_catalog_video` | `POST /catalog/video/delete/`, followed by a filtered absence read |

These definitions serve MCP, CLI and REST. No generic dispatcher or dashboard
interaction is needed for normal agent use. Explicit catalog grants remain an
owner setting; an agent cannot expand its own access.

## Agent upload workflow

1. Prepare a CSV with required headers `video_name,video_link,sku_id_list`.
   Quote a SKU field containing commas. For example:

   ```csv
   video_name,video_link,sku_id_list
   Summer clip,https://media.example/summer.mp4,"SKU-001,SKU-002"
   ```

2. Stage the CSV in central Adport media through the existing agent upload,
   cloud CLI, direct widget upload or dashboard. Keep its immutable `media_id`
   and SHA-256. The catalog endpoint accepts a CSV of video URLs, rather than a
   raw video file. Referenced videos must remain fetchable by TikTok during
   processing. Existing central-media and advertiser-library workflows can
   supply media; the agent must arrange suitable source accessibility.
3. Call `tiktok_catalog_video_import_context` with `account_id`, `bc_id`,
   `catalog_id`, `media_id`, `expected_sha256` and hosted `project_id`. It verifies
   the bytes and every referenced SKU, then returns `expected_catalog_hash` and
   `expected_associations_hash`.
4. Request a `tiktok_upload_catalog_videos` preview with those arguments/hashes
   and `acknowledge_shared_effects`, `acknowledge_possible_delivery` and
   `acknowledge_async_processing` all `true`. Review the catalog, video/SKU
   counts and possible effect on existing catalog ads. Apply the identical
   arguments with its `pending_operation_id` after approval.
5. Reconcile the returned `feed_log_id` with `tiktok_catalog_video_log`, then
   inspect `tiktok_catalog_videos` for extraction/activation state and previews.

Apply rechecks the catalog, source checksum and SKU identities/eligibility.
Only apply mints a private download grant for the CSV. That grant and the
original video links stay out of tool responses, approvals and audit logs.
The CSV is submitted unchanged. Text summaries show at most 20 rows, with source
origins/fingerprints rather than complete source URLs.

Adport locally limits a source CSV to 50 MiB, 5,000 data rows and 5,000 distinct
SKU associations. Each video requires 1–20 distinct exact SKU strings, all
natively `ad_creation_eligible: AVAILABLE`. These local limits bound preflight
work; they do not assert successful native ingestion. Optional native columns
are `category`, `brand`, `creator`, `video_type`, `description`,
`landing_page_url` and `custom_label_0` through `custom_label_4`. Names and the
first five optional text fields are limited to 500 characters. Adport rejects
long optional values because TikTok documents silently replacing them with null.

TikTok documents a 100 MB limit per video and, for TikTok placement, 5–60 seconds,
16:9/1:1/9:16 aspect ratios, minimum 960×540/640×640/540×960 resolution and bitrate
above 516 kbps. Native processing checks media accessibility and eligibility;
CSV validation does not certify those properties. Only one native file task
can run at a time. Inspect an existing/uncertain job before another submission.

`sync_to_selected_account` defaults to `false`. Enabling it also requires
`acknowledge_account_copy: true` and requests sync only to the selected
advertiser. TikTok ignores ineligible advertiser IDs; the submission therefore
reports sync requested separately from sync confirmed. It never certifies a
copy merely because an ID was sent. No campaign/ad status or budget is changed,
but adding a catalog video can affect an already active catalog ad.

## Browse and remove

Catalog video IDs are opaque composite strings, not numeric IDs. Native pages
hold at most 50 videos. **Load more** appends previews while retaining existing
players and scroll. An explicit `catalog_video_ids` filter accepts up to 50 IDs
and ignores pagination, as documented; its completeness covers only that
filtered view. Missing or contradictory pagination remains unknown.

`SUCCESS`/`PENDING`/`FAILED` describe extraction;
`ACTIVATED`/`DEACTIVATED` describe availability for delivery. A task's
`WAITING`/`PROCESSING`/`SUCCESS`/`FAILED` state is separate from both. Missing
counts remain unavailable. Accepted work displays **Processing pending**, not
completed ingestion or confirmed advertiser-library sync. Native error envelopes
remain errors. Uncertain writes retain known IDs and are never replayed.

Successful extraction can provide a six-hour native preview link. Refresh the
gallery to renew it. Displayed metadata is clipped at 1,000 characters per
field, with explicit truncation flags; configuration hashes bind the full native
values. Diagnostic output exposes bounded field/count summaries, excluding
free-form samples, original links and diagnostic download capabilities.

The gallery's **⋯ → Remove from catalog** requests the ordinary guarded preview.
Write controls are omitted for read-only catalog grants. An agent can invoke
the same tool with one `catalog_video_id`, its fresh `configuration_hash` as
`expected_configuration_hash`, and `acknowledge_shared_effects: true`. Apply
rechecks that snapshot, deletes exactly one entry and independently verifies its
absence from a filtered catalog view. Copies already synced to advertiser
creative libraries remain separate. Existing ads may be affected; there is no
claim of global/atomic usage verification or a native restore endpoint.
The current documented video family has no metadata-edit or activation setter;
Adport does not invent either operation.

Contracts were refreshed from TikTok's official documentation on 2026-11-05:
[video workflow](https://business-api.tiktok.com/portal/docs?id=1803654904260674),
[CSV upload](https://business-api.tiktok.com/portal/docs?id=1803655037415489),
[task log](https://business-api.tiktok.com/portal/docs?id=1803655061642242),
[video information](https://business-api.tiktok.com/portal/docs?id=1803655082498050)
and [deletion](https://business-api.tiktok.com/portal/docs?id=1803655103069185).
The [official SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/f809c396520df2d7b201a9ccc5378d822b728ed3/python_sdk/docs/CatalogApi.md)
also documents composite-ID filters and deletion. CSV columns follow the current
official parameter table; the linked template's cell export and positive native
ingestion have not been independently verified. Wire, policy, privacy and
synthetic OpenAI/MCP bridge tests do not establish actual Claude/ChatGPT host or
native advertiser success. Those checks remain pending.

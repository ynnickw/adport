# Spotify campaign drafts and creative media

Spotify's draft workflow stages changes without altering published delivery. All advertising mutations use the same registry and preview/apply policy in the CLI, local MCP and hosted MCP.

## Build and edit

1. Create a campaign with `spotify_create_campaign_draft`. Policy defaults it to `PAUSED`.
2. Create unpublished children with `spotify_create_draft_ad_set` and `spotify_create_draft_ad`. Partial drafts are supported. Monetary values are integer account-currency micros. Targeting requires explicit `placements`; lifetime budgets require an end time.
3. Read the hierarchy with `spotify_drafts` and `spotify_get_draft`. `spotify_ad_sets` reads published settings. `spotify_ads` renders actual copy and media for published or draft ads. Draft cards include copy-edit actions; published cards can stage a draft for editing.
4. Use `spotify_update_draft_campaign`, `spotify_update_draft_ad_set` and `spotify_update_draft_ad` for minimal patches. Omitted targeting dimensions are preserved; supplied arrays or nested dimensions replace their previous values. Omitted asset IDs and CTA fields are preserved. CTA languages use native values such as `ENGLISH`, separately from targeting language codes such as `en`.

`spotify_create_draft_from_published` verifies account ownership and refuses to overwrite an existing draft. Read an existing draft before combining new changes with its pending state.

## Validate and publish

Fetch the current **campaign** `draft_hierarchy_version` after editing any child. `spotify_validate_draft` validates that exact version without publishing. Spotify may report invalid/incomplete hierarchies as HTTP400; bounded native messages, error codes and trace IDs are returned with credentials redacted.

The live `PUBLISH` endpoint activates campaigns **even when their draft status is PAUSED**. `spotify_publish_draft` therefore rejects publication before any API call while `paused_creation` is enabled. Keep the validated hierarchy as a draft under this policy. Adport never disables the policy to publish.

When an operator has independently chosen a policy permitting active creation, publication additionally requires `acknowledge_active_publication=true`. Its separate preview/apply pair shows the ACTIVE transition, binds the exact hierarchy version, checks current/proposed child money and validates before publishing. This is an active launch operation.

The live campaign status PATCH accepts only `ACTIVE` and `PAUSED`; the broader response enum includes `ARCHIVED`, but that update was rejected in real verification.

## Media and discovery

`spotify_assets` displays image, video and audio assets. Create metadata with `spotify_create_asset`, then upload to that exact `WAITING_UPLOAD` ID using `spotify_upload_asset`. The SHA-256 binds approval to the uploaded bytes. Existing ready/processing assets cannot be overwritten through this tool. `spotify_rename_asset` changes metadata only.

Hosted uploads use project-scoped `media_id`; local CLI/stdio uploads use an absolute `file_path`. Files above20MB use Spotify's native upload session, server-selected chunk size and numbered transfers. Adport caps provider uploads at100MiB and hosted staging at50MiB. Processing can continue after the upload succeeds; call `spotify_get_asset` to check readiness. Spotify v3 exposes no asset-delete endpoint.

Use `spotify_ad_categories`, `spotify_targeting_options`, `spotify_geo_targets`, `spotify_audience_estimate` and `spotify_bid_estimate` to resolve native category/targeting choices and non-binding forecasts. Estimates do not change delivery.

## Delete drafts safely

Delete **ad drafts first**, then ad-set drafts, then the campaign draft. `spotify_delete_draft_ads` and `spotify_delete_draft_ad_sets` expose the native atomic batch endpoints. Parent deletion is refused while child ad drafts remain. During live verification, deleting a campaign first left a readable ad draft whose individual and batch deletes failed with `Campaign not found for Ad Draft`. The guard prevents creating that condition in subsequent workflows; it cannot repair an existing provider orphan.

## Audiences, insights and CSV exports

`spotify_audiences`, `spotify_get_audience` and `spotify_audience_datasets` read existing sources. `spotify_create_audience` supports web events from eligible account datasets or engagement with account-owned campaigns/ad sets. `spotify_create_lookalike_audience` verifies the existing seed audience. Metadata edits preserve the native audience type; deletion checks the provider's removed-record count. These tools do not upload customer lists or attach an audience to ad targeting.

`spotify_insight_report` requires exactly one published, account-owned `ad_set_id`, matching the live endpoint's restriction. The broader entity types in the published schema were rejected. Spotify additionally requires more than500 delivered impressions; the QA ad set correctly returned HTTP422 at that eligibility check. Returned native fields, including omitted/suppressed conversions, are preserved. `spotify_change_history` reads the provider's rolling180-day account history.

`spotify_create_report` submits an asynchronous CSV job through preview/apply. Use `spotify_report_status` for its status and native download URL; Adport does not fetch arbitrary report URLs. Submission is separate from completed export generation. A live QA export was accepted and remained PROCESSING during subsequent checks.

## Verification limits

Real-account verification covered draft hierarchy creation/editing, complete audio hierarchy validation, gallery copy, category/targeting discovery and SHA-bound image/audio uploads. A publication test exposed the forced ACTIVE transition; the test campaign was immediately paused and confirmed PAUSED/OFF. It remains paused because the API rejected archiving. Contract tests enforce default-policy publication rejection, explicit active-launch acknowledgement, hierarchy versions, failed-validation prevention, budget caps, account ownership and shared approval tokens. Provider video upload, advanced measurement and live host widgets require their own verification.

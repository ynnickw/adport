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

`spotify_publish_draft` is a separate preview/apply operation. It rejects a changed version, checks current and proposed child budgets/bids, then validates before sending `PUBLISH`. With `paused_creation` enabled, the draft campaign must already be `PAUSED`. Publication does not automatically activate it. A server validation error prevents the publish call.

## Media and discovery

`spotify_assets` displays image, video and audio assets. Create metadata with `spotify_create_asset`, then upload to that exact `WAITING_UPLOAD` ID using `spotify_upload_asset`. The SHA-256 binds approval to the uploaded bytes. Existing ready/processing assets cannot be overwritten through this tool. `spotify_rename_asset` changes metadata only.

Hosted uploads use project-scoped `media_id`; local CLI/stdio uploads use an absolute `file_path`. Files above20MB use Spotify's native upload session, server-selected chunk size and numbered transfers. Adport caps provider uploads at100MiB and hosted staging at50MiB. Processing can continue after the upload succeeds; call `spotify_get_asset` to check readiness. Spotify v3 exposes no asset-delete endpoint.

Use `spotify_ad_categories`, `spotify_targeting_options`, `spotify_geo_targets`, `spotify_audience_estimate` and `spotify_bid_estimate` to resolve native category/targeting choices and non-binding forecasts. Estimates do not change delivery.

## Delete drafts safely

Delete **ad drafts first**, then ad-set drafts, then the campaign draft. `spotify_delete_draft_ads` and `spotify_delete_draft_ad_sets` expose the native atomic batch endpoints. Parent deletion is refused while child ad drafts remain. During live verification, deleting a campaign first left a readable ad draft whose individual and batch deletes failed with `Campaign not found for Ad Draft`. The guard prevents creating that condition in subsequent workflows; it cannot repair an existing provider orphan.

## Verification limits

Real-account verification covered draft campaign/ad-set/ad creation and editing, gallery copy, category/targeting discovery, SHA-bound image/audio uploads and asset processing reads. Contract tests cover native chunk fields, hierarchy-version rejection, failed-validation publication prevention, budget caps, account ownership and shared approval tokens. Complete publication, video upload, advanced audience/measurement workflows and live host widgets require their own verification; these are not implied by tool availability.

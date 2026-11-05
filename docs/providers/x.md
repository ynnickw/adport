# X Ads

The local CLI and MCP runtime include this provider, tested against official
response contracts. Adport's cloud application received Standard Ads API access
on August 31, 2026. Self-hosters still need their own approved application;
app approval is separate from live verification of individual API operations.

## Connect locally

Use your own Ads API-approved developer app. Securely provide `X_CONSUMER_KEY`,
`X_CONSUMER_SECRET`, `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET` in your shell
environment, then run `adport connect x`. Do not put secrets in command arguments,
chat messages or the repository. The command verifies account discovery before
replacing the local grant and stores credentials with mode 0600. It does not use
the Adport Cloud OAuth broker. `adport disconnect x` removes the local copy only.

## Implemented and contract-tested

- Hosted OAuth helpers implement request-token creation, access-token exchange
  and revocation. Temporary tokens require callback confirmation; signatures
  include the registered callback/verifier, with no secrets in URL queries.
  Form-token parsing rejects duplicate/missing fields and oversized bodies;
  failures are sanitized and one-time exchanges are never automatically retried.
  Cloud uses a default-off rollout gate and organization/user-bound single-use
  transactions. See [hosted onboarding](cloud-onboarding.md).
- OAuth 1.0a HMAC-SHA1 via `oauth-1.0a`, Node crypto and cryptographic nonces.
  Four credentials are required: consumer key/secret and user access token/secret.
  Bearer tokens are not a replacement for Ads API user authentication.
- Fixed HTTPS v12 API origin, redirect rejection, 30-second request timeout,
  sanitized errors, no automatic replay of writes, and schema validation.
- Query parameters on GET, POST and PUT are signed exactly as transmitted.
  Spaces are serialized as `%20` because the signing library does not interpret
  form-style `+` as a space when parsing a query URL. Tests independently calculate
  signatures, including Unicode, punctuation, spaces and literal plus signs.
- Cursor-paginated account, funding-instrument, campaign, line-item and
  promoted-tweet discovery. Duplicate entities and cursor cycles fail closed.
- Accounts have no currency field; no currency is invented. Funding instruments
  and campaigns carry the currency. Tweet snowflakes remain strings.
- Campaign-write planner for create, status and existing daily/total budget
  changes. Creation uses `budget_optimization=LINE_ITEM`, explicit paused policy
  coercion and integer account-currency micros. Funding ownership and availability
  are checked before creation. Previews make only reads. Apply responses must
  match the approved fields and preserve untouched budgets and status.
- Shared tools expose campaign/funding/line-item reads and guarded campaign,
  line-item and targeting mutations. Writes use `guardedWriteTool` and
  the shared policy engine's exact preview/apply gate. Integration tests verify
  mismatched pending arguments, budget caps and protected-account rejection.

## Reporting

The implementation follows these current official contracts:

- Native entities: campaign → `CAMPAIGN`, ad group → `LINE_ITEM`, promoted post
  → `PROMOTED_TWEET`. Account-level `ACCOUNT` analytics lack the BILLING group;
  account reports therefore aggregate campaign analytics, rejecting mixed-currency
  totals. Ad reports include promoted posts/accounts and media creatives; IDs
  include the native entity type to avoid collisions between creative namespaces.
- Separate requests for `ALL_ON_TWITTER`, `SPOTLIGHT` and `TREND` to produce full
  placement totals. A single-placement report must not be labeled a full total.
- At most 20 entity IDs per analytics request, with comma-separated IDs/groups.
- `TOTAL` returns `time_series_length: 1`, with `data[].id_data[].segment: null`
  and metric arrays under `metrics`. Null values are zero-equivalent according to
  X's FAQ; missing unsupported fields need separate handling.
- `billed_charge_local_micro` is spend in currency micros. `clicks` includes
  likes and other engagements; `url_clicks` measures link/Website Card clicks.
- Inclusive Adport dates must become an exclusive end boundary. Whole-hour
  timestamps are required; midnight in the account timezone matters for matching
  the Ads Manager reporting day. Explicitly handle DST and timezone changes.
- Synchronous analytics has a 7-day maximum range. Longer-range and historical
  queries use async analytics in at most 30-day chunks. The implementation polls
  exact `id_str` job IDs, validates account/filters/date scope and accepts downloads
  only from the documented HTTPS host and matching job path, without OAuth headers.
  Downloads and decompressed data are bounded to 20 MiB. A bounded polling timeout
  retains the handle so an identical request on the same running client resumes
  the existing job. Restarting the process does not retain that in-memory handle.
- Reports cover spend, impressions, link clicks, CTR, CPC and CPM. Conversion
  counts, conversion value, CPA and ROAS are not normalized yet: the purchase
  object contract and sale-amount units still need official verification. These
  fields remain absent, never fabricated as zero; requests containing only these
  unsupported metrics fail with an explicit explanation. Native conversion objects
  are available separately through `x_conversion_stats`, described below.
- Missing fields remain unknown across aggregation; explicitly null scalar
  metrics are zero-equivalent per X's documentation. Duplicate/missing entity rows,
  unexpected segmentation or changed report scope are rejected.
- Reporting dates before an account timezone switch are rejected because its old
  timezone is unavailable. Timezones whose midnight cannot be represented by the
  API's whole-UTC-hour constraint are also rejected, not rounded silently.

## Line-item configuration and lifecycle

`x_get_campaign` and `x_get_line_item` expose exact native configuration. Line-item reads preserve additional fields, nullable names, money and schedule settings. An exact line-item lookup verifies its parent through the selected account’s campaign route and checks currency consistency. Reporting uses the ID when a native name is null.

`x_create_line_item` creates a PAUSED ad group under an existing non-draft `LINE_ITEM` budget campaign. It requires an explicit objective, product, placements and flight; sibling line items must use the same objective/product. Native requests use signed query parameters and CSV placements. App objectives require an explicit app-store ID, and the preview reports native automatic platform targeting. Publisher-network placement needs an advertiser domain and IAB categories. Placement combinations can be inspected with `x_line_item_placements`.

Creation also accepts a documented native `goal` and `primary_web_event_tag`.
`WEBSITE_CONVERSIONS` requires a primary event ID and the
`expected_web_event_tag_hash` from `x_get_web_event_tag`. Any supplied primary
event requires that hash. Adport reads the exact account-scoped event on preview
and apply, rejects deleted/foreign or changed configurations, and includes the
event name/type, goal, native event status, placements, flight and money in the
review. Native event status alone does not establish measurement accuracy.
New ad groups still follow paused-creation policy. The snapshot is an Adport
approval check and is never sent as an X API parameter.

Native creation receipts and independent ad-group readback must match the goal,
primary event, status and approved configuration. Unconfirmed readback retains
the created ID and never automatically repeats creation. This path installs no
pixel and sends no conversion event. Current documentation establishes the
primary-event parameter on creation; Adport does not infer an existing-group
rebind/clear route from that. Native goal/account eligibility remains checked by
X on apply. Event configuration hashes include name, type, retargeting and
attribution windows; volatile tracking diagnostics are excluded.

Name/schedule edits, status, daily/total caps and bidding have separate named tools. Omitted bounds/settings remain unchanged. Money uses integer micros with current-value lookup and shared policy checks. Native `AUTO` ignores a monetary bid; the tool rejects a purported AUTO cap and removal of an existing bounded bid through AUTO. `MAX`/`TARGET` eligibility follows the documented objective restrictions. Receipt checks bind ID, campaign, currency, status, requested settings and preserved monetary caps. Unexpected native changes retain the returned ID and require reconciliation before retrying.

`x_delete_line_item` requires its relevant promoted-post/account/media children to be removed first, then uses native DELETE and checks the returned deleted flag. Unknown product types are rejected for deletion rather than assuming all child types have been checked. All advertising writes still use the same exact-argument preview/apply gate, audit log, protected-account and budget rules. X does not provide server validation for this workflow.

Published promoted-only post creation, name edits, post galleries and promoted-post association/removal now have [typed workflows](x-posts.md). Native associations are ACTIVE and have no PUT status endpoint: paused creation requires a currently PAUSED ad group. The review keeps publication, association and delivery separate. Portions of measurement and other native formats remain outstanding; these additions are partial API coverage. The provider-owned [MCP reference](https://github.com/xdevplatform/docs/blob/4e8f626258b26f97826490989f3136fe096a8252/x-ads-api/mcp/reference.mdx) is an API comparison source, not evidence that Adport implements every route.

## Targeting

`x_targeting_options` reads twelve native choice dimensions with dimension-specific filters. Supported native cursors are returned without dropping rows from oversized pages. Unpaged endpoints explicitly report potential truncation; an unsupported filter or unusable cursor is rejected rather than silently ignored. `x_targeting_criteria` and `x_get_targeting_criterion` verify the selected account's campaign/line-item hierarchy before returning criteria.

Single add/remove tools preserve other dimensions. `x_update_targeting` uses the native atomic JSON batch for up to 500 combined additions/removals on one line item, including geographic replacements and engagement source/type pairs. The planner checks the final state, rejects duplicate criteria and multiple age buckets, requires included geography for TV shows, and warns if the last included location is removed. Existing omitted criteria remain unchanged. Eligibility and compatibility beyond these checks are still decided by X.

Referenced custom audiences must be available and targetable in the account; engagement campaigns, FULL promotable users and exclusion-only app lists are checked against native account resources. Source availability is checked again at apply. Batch signatures exclude the JSON body from OAuth form normalization. Ordered receipts must match the approved operations; item-level errors and mismatches retain safe resource IDs for reconciliation and are never retried automatically. Targeting writes can change delivery immediately on an active line item and use the normal shared preview/apply gate.

Live reads on 2026-11-03 verified placement combinations and language/location/platform-version options through an existing authorized connection. X returned five Berlin location rows despite a requested count of two; Adport retained the full page and reported this. Native query results are returned as received, without claiming the provider honored every filter. Targeting mutations remain contract-tested only; the available X account is REJECTED and has no line items for live mutation verification.

## Creative drafts and media library

`x_draft_tweets` and `x_media_library` return native copy and image/GIF/video previews through the shared creative widget. Copy and rename actions bind the account and exact draft/media ID and request an ordinary policy preview. Preview hydration is bounded to 100 distinct account-owned media items; failed reads leave native references visible with a warning. Media URLs are restricted to native HTTPS CDN origins. Snowflake IDs stay strings.

`x_create_draft_tweet` creates a promoted-only native draft. It does not publish a post or associate it with an ad. Authoring verifies a current FULL promotable user and the authenticated actor's identity or TWEET_COMPOSER permission. Attached media must be ready and associated with the account; new card references are verified through the account's native cards/all route. `x_promotable_users`, `x_authenticated_user_access`, exact draft/media reads and `x_get_cards` expose those native resources.

`x_update_draft_tweet` sends only supplied fields and preserves omitted copy/name/media/card values, author and nullcast state. An explicit empty media array or null card clears that attachment. `x_delete_draft_tweet` uses native hard deletion and verifies DELETED; a published post remains separate. Native weighted text length/content rules are checked by X on apply: the local preview explicitly is not server validation. No JavaScript string-length approximation is presented as a native post limit.

Media metadata updates preserve omitted settings and verify the returned media key/type and content. Video poster changes require a ready account-owned image. Native library deletion is distinct from an ad pause or underlying byte deletion; existing posts/ads may retain media. Every mutation uses the shared two-step policy and audit path, with returned IDs retained if a receipt cannot be reconciled. Draft/library tools do not publish or promote; the separate [published-post workflows](x-posts.md) require their own source context and approval.

Live verification on 2026-11-03 covered account permissions/FULL author discovery, native media-library pagination and real image/video previews, then a named text-only QA draft create → read → copy edit → rename → delete lifecycle. Every write used the shared preview/apply gate; the exact deleted draft returned 404 afterward. Live text-only PUT omitted the unchanged name, so updates accept a partial receipt and require a complete readback to verify preservation. The temporary draft was never published or associated with an ad. Media metadata/deletion and attachment-based draft creation still need live verification.

## Website, app and carousel cards

`x_cards` lists native modern cards with optional legacy inclusion, account-bound configuration hashes, cursor pagination and bounded image/video previews. It preserves every returned card when the provider exceeds the requested count. Media hydration stops at 100 distinct references and reports missing previews without hiding native content. `x_get_card` reads one modern numeric card ID; the existing `x_get_cards` remains the separate exact-URI lookup through `cards/all`.

`x_create_card` authors an unattached website/app card, a single-destination image/video/mixed carousel, or a multi-destination website carousel. Components preserve native order; carousel layouts use two to six media. Every referenced image/video must be ready and associated with the selected account. App destinations require country and at least one store identifier, with matching store IDs for supplied deep links. These tools do not publish posts or create promoted-post associations. Lead-form/button-group and legacy-specific authoring are separate workflows.

`x_update_card` requires a current configuration hash and `acknowledge_shared_creative_effects: true`. Omitted name/layout fields are preserved. Supplied components or slides replace the layout. Title, website URL and app-button shortcuts preserve the supported current layout; multi-destination copy changes require an explicit zero-based `slide_index`. Unsupported native component fields are retained in reads and rejected by copy shortcuts rather than silently discarded. The widget provides guarded name/copy/button edits with the exact displayed snapshot.

Updates and deletion can affect existing posts or ads that reuse a card. `x_delete_card` requires the same snapshot and effects acknowledgement, verifies the exact native deleted receipt and independently reads its tombstone. No restore endpoint has been established. None of these operations changes campaign/line-item status or budgets, and deletion is not an ad pause. The normal policy preview/apply and append-only audit gate apply to every mutation.

Card writes use native JSON bodies. POST returns an object; GET/PUT/DELETE return arrays. Adport checks these distinct shapes and independently verifies approved content. A mismatch or uncertain result retains original/returned IDs for reconciliation and is never automatically retried. Native eligibility and content limits remain authoritative; previews are local, not server validation. Current official contracts were rechecked on 2026-11-05 against [the provider-owned reference](https://github.com/xdevplatform/docs/blob/a9226e1066661622a1e4f9528888927cb3d31c2a/x-ads-api/creatives/reference.mdx). Native QA status is recorded separately from wire-contract tests.

## Checksum-bound native uploads

`x_upload_media` reads an immutable project media ID in hosted runtimes or an absolute local file through the CLI/stdio resolver. The exact SHA-256, content type, byte size and author appear in the preview and are verified again at apply. Hosted runtimes reject server file paths. Application limits are 5 MiB for images, 15 MiB for GIFs and 50 MiB for video; native duration/account eligibility can impose additional limits.

The implementation follows the current provider-owned v2 OpenAPI: OAuth1 UserToken is supported alongside OAuth2 media.write. It signs fixed api.x.com initialize/append/finalize paths, sends 1 MiB JSON/base64 chunks, assigns the verified FULL advertiser as an additional owner, and never replays writes automatically. It does not use legacy command-style INIT/APPEND/FINALIZE parameters or expose arbitrary upload URLs.

A finalized upload returns a short-lived HMAC receipt bound to the account, author, native ID/key, checksum, size and finalization state. `x_media_upload_status` requires this receipt before calling the native account-less status endpoint. Receipts expire no later than native upload expiry or 24 hours, and another grant cannot verify them. Current author association is rechecked. Processing acceptance is distinct from readiness.

`x_register_uploaded_media` separately previews/apply-registers a processed upload in the same account's library and verifies complete metadata readback. Pending, incomplete, expired, wrong-account and already-registered uploads are rejected. Upload or registration failures retain safe IDs and receipts for reconciliation. A failed incomplete upload can leave bytes until native expiry; library deletion does not claim to remove global uploaded bytes. Neither upload nor registration publishes a post or attaches an ad.

The first local live initialize request timed out without a returned upload ID. A separate unauthenticated connectivity check also timed out against api.x.com while ads-api.x.com remained reachable. No automatic write retry occurred. Native v2 upload/registration is contract-tested and awaiting successful live endpoint verification; earlier Ads API draft/media reads and draft lifecycle verification are separate evidence.

Official contracts: [v2 OpenAPI](https://github.com/xdevplatform/docs/blob/2f701ee04b362fffcc1dfee042b11b64ab884fda/openapi.json), [chunked media upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked).

## Custom audiences

`x_custom_audiences` and `x_get_custom_audience` inspect owned or already shared
audiences, native processing diagnostics and a `configuration_hash`. Lists use
native cursors and the compact widget's **Load more**. `with_total_count` requests
a total on the initial page; continuation automatically omits that flag because
X does not allow it alongside a cursor. A missing native cursor marker leaves
completeness unconfirmed.

`x_create_custom_audience` creates an empty CRM placeholder. Metadata edits use
`x_update_custom_audience`, a current configuration hash and the shared
preview/apply gate. Omitted name/description fields stay unchanged. Create and
metadata writes independently read back their results. They upload no members,
add no targeting, grant no sharing and activate no ads.

`x_update_custom_audience_users` submits explicit native `Update`/`Delete` groups.
Each group contains `params.users` and optional UTC `effective_at`/`expires_at`.
All identifiers must already be normalized SHA256 hashes, except the native
`partner_user_id` exception. Previews show counts and a batch checksum; member
identifiers stay out of previews, audit summaries and widget approval arguments.
Hosted pending arguments use the existing encrypted project approval store.
The tool is marked destructive because batches can remove members.

Native limits are 2,500 operation groups and a 5,000,000-byte JSON body. Adport
also limits one approved request to 2,500 total user records. The native receipt's
success and total counts must both match the submitted record count. A successful
receipt means **accepted for processing**, with readiness explicitly unconfirmed;
it does not prove exact membership or targeting availability. Existing ads using
the audience can be affected. X describes processing batches on a 6–8-hour cycle.
Transport failures, partial counts and operation errors never trigger automatic
replay. Permissions remain provider-controlled; tool availability does not grant
audience API approval.

`x_custom_audience_permissions` inspects existing sharing. `x_custom_audience_usage`
checks targeted campaigns, inactive groups, direct inclusion/exclusion criteria
and sharing grants, returning a `usage_hash`. It requires complete native paging,
with bounds of 25 pages per scan and 5,000 rows/line items/criteria. Deletion uses
both hashes through `x_delete_custom_audience`, rejects referenced or shared
audiences and independently verifies native `deleted=true`. These checks cannot
atomically lock other clients; no restore endpoint is claimed.

Ordinary CRM lifecycle and inspection are implemented. Flexible-audience batch
creation (documented closed beta), sharing/revocation and Do Not Reach list
management are separate workflows. Conversion configuration and normalization
remain separate work. The new audience tools are contract/widget tested; live
X account and Claude/ChatGPT validation remain unverified.

Contracts: [current audience reference](https://docs.x.com/x-ads-api/audiences/reference)
and [provider-owned Python SDK](https://github.com/xdevplatform/twitter-python-ads-sdk/blob/a3dd5819341e77aa469d0b4b3399f0bcd028c80c/twitter_ads/audience.py),
inspected 2026-11-05. No SDK retry or cleanup behavior is executed by Adport.

## Measurement and native conversion reports

`x_web_event_tags` / `x_get_web_event_tag` inspect existing website conversion
tags. Embed code stays inert text; reads never execute it, install a pixel or
send an event. The current X MCP reference confirms the v12 routes, while the
provider-owned Ruby SDK supplies the web-tag resource fields. Web-tag authoring
and deletion still need a current detailed payload/receipt contract and native
verification; a documented route alone is not sufficient write coverage.

`x_app_event_tags` / `x_get_app_event_tag` expose native app identity, conversion
type, retargeting settings and post-view/post-engagement attribution windows.
Lists retain native pages and ID filters. `with_total_count` applies only to the
initial page; cursor continuation omits it. Missing cursor metadata leaves page
completeness unknown. App-tag creation/deletion and conversion-event ingestion
are separate workflows.

`x_tracking_tags` / `x_get_tracking_tag` inspect existing impression and click
trackers, verifying their line-item/campaign hierarchy in the selected account.
Reads return a configuration hash. `x_create_tracking_tag` associates a supplied
HTTPS tracker with an existing non-draft line item; `x_update_tracking_tag`
changes only its URL. Updates preserve its type, parent and other native
configuration. `x_delete_tracking_tag` disassociates it and verifies a native
deleted tombstone. No restore endpoint is claimed. Changes can affect
measurement immediately on active ads, but these tools send no test events and
change no delivery status, budget or bid.

All tracking mutations use the shared preview/apply policy and audit gate.
Updates/deletion require the exact current configuration hash; apply replans
and checks it again. Timestamps are excluded from that hash. Native query
parameters are signed as transmitted. An accepted receipt is followed by an
independent readback. Uncertain or mismatched results retain safe IDs for
reconciliation and never trigger automatic replay. These checks do not lock
other clients atomically.

`x_conversion_stats` returns native `WEB_CONVERSION` or separately requested
`MOBILE_CONVERSION` objects for up to 20 verified campaigns, line items or
promoted posts and at most 30 inclusive account-local dates. `placement` is
required: results cover that placement, rather than claiming all-placement
totals. Native attribution buckets, event types, sale amounts and order
quantities remain separate, with `normalized: false`. Empty/missing objects
are not invented as zero. No conversion revenue, currency conversion, CPA or
ROAS is inferred from unverified object fields. Historical/longer periods use
the existing bounded async-job download path; native request scope and entity
IDs are checked before results are returned.

Contracts inspected 2026-11-05: [tracking-tag reference](https://docs.x.com/x-ads-api/campaign-management/reference#tracking-tags),
[app-event reference](https://docs.x.com/x-ads-api/measurement/mobile-conversions#app-event-tags),
[analytics](https://docs.x.com/x-ads-api/analytics),
[current MCP route map](https://docs.x.com/x-ads-api/mcp/reference), and
[provider-owned web-tag resource](https://github.com/xdevplatform/twitter-ruby-ads-sdk/blob/0b6759a21236617ba5c4f39178e7a73fc1a4ae4e/lib/twitter-ads/measurement/web_event_tag.rb).
Wire-contract, shared policy and widget tests are separate from live native
endpoint and Claude/ChatGPT host verification.

## Access and commercial boundary

Ads API approval is separate from general X API access. An active developer app
or a general project tier is not evidence of Ads API approval. After approval,
X instructs developers to regenerate user access tokens. Local users bring their
own approved app credentials; hosted customer onboarding requires a reviewed
multi-user OAuth flow and appropriate provider permission.

No monthly/request access price was confirmed from the public Ads API onboarding
docs. Do not promise free access or apply general X API prices to Ads endpoints.
Ask Ads Support to confirm fees, spend requirements and the proposed SaaS/MCP use.

## Official references inspected 2026-08-31

Line-item/creative contracts were refreshed on 2026-11-03 against provider-owned docs at commit `2f701ee04b362fffcc1dfee042b11b64ab884fda`. Existing authorized campaign/line-item list reads succeeded; new mutation flows still require live endpoint verification. Native eligibility, grant and host-widget verification remain separate from synthetic wire tests.

- [Campaign management reference](https://docs.x.com/x-ads-api/campaign-management/reference)
  ([official source](https://github.com/xdevplatform/docs/blob/main/x-ads-api/campaign-management/reference.mdx))
- [Analytics reference and FAQ](https://docs.x.com/x-ads-api/analytics)
  ([official source](https://github.com/xdevplatform/docs/blob/main/x-ads-api/analytics.mdx))
- [Making authenticated requests](https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests)
- [Creating a signature](https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature)
- [OAuth 1.0 specification, photo-request test vector](https://oauth.net/core/1.0/)
- [Ads API application guide](https://docs.x.com/x-ads-api/getting-started/step-by-step-guide)
- [API versions](https://docs.x.com/x-ads-api/fundamentals/versioning)

Verification: synthetic wire-contract, reporting, download-security, write-plan
and shared policy-gate tests pass, as do local CLI onboarding tests. All package
builds/tests/typechecks and the public-tree check pass. No live API request, ad
mutation, provider application submission or npm release is implied by these tests.

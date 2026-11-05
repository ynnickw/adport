# LinkedIn Ads — local connection

Use your own [LinkedIn developer app](https://www.linkedin.com/developers/apps) with Advertising API approval and an authorized ad-account member. App creation requires association with a real LinkedIn Company Page; a member profile is not a substitute.

## Local workflow

1. Obtain approval for the app's Advertising API product and the permissions needed for your use case. Adport's read/write surface uses `rw_ads` and `r_ads_reporting`.
2. Generate an authorized access token through the app's Developer Portal token generator, or implement the authorization-code flow on your **own registered HTTPS callback**. Adport exports `buildLinkedInAuthUrl` and `exchangeLinkedInCode` for this flow.
3. Supply `LINKEDIN_ACCESS_TOKEN` securely through your environment and run `adport connect linkedin`. Do not paste tokens into chat, issues or shell history. The CLI does not ask for echoed secrets or invent an HTTP loopback callback.
4. Account discovery must succeed before the old local connection is replaced. The new credentials are stored in `~/.config/adport/credentials.json` with mode 0600.

Optional environment values:

- `LINKEDIN_EXPIRES_AT`: access-token expiration as Unix milliseconds.
- `LINKEDIN_REFRESH_TOKEN`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`: complete partner refresh grant. Only approved Marketing Developer Platform partners receive programmatic refresh tokens.
- `LINKEDIN_REFRESH_EXPIRES_AT`: fixed refresh-grant expiration as Unix milliseconds.

Access-only tokens are supported; reauthorize/import when they expire. LinkedIn documents default access-token lifetimes of 60 days and refresh-token lifetimes of one year. Refreshing does not restart that year. Store-backed credentials persist refreshed access tokens and expirations; environment-only consumers must handle persistence themselves. No shared Adport Cloud client is involved.

## Implemented surface and limits

- Account, campaign and campaign-group discovery with cursor pagination (`metadata.nextPageToken`). Inactive campaigns are included.
- `linkedin_get_account` reads exact native account settings, status and organization reference, verifying the returned ID. Discovery and an account's organization reference do not prove billing eligibility or Page-content permissions.
- Normalized reports for account, campaign and creative (`ad`) levels. LinkedIn has no native ad-group entity; `ad_group` is rejected explicitly rather than duplicating campaign data. Campaign groups can be listed separately.
- Guarded campaign creation under an existing campaign group; paused creation, exact decimal money, and account/group ownership checks. This creates the campaign only, not creatives, lead forms or a complete serving campaign hierarchy.
- Guarded campaign status and existing daily/total budget updates using Rest.li partial updates. Group-shared dynamic budget creation is rejected because its policy semantics differ from ordinary campaign budgets.
- Explicit non-political advertiser confirmation for creation and activation. Creation previews carry LinkedIn's targeting nondiscrimination notice. Do not infer consent on the advertiser's behalf. Political campaigning is not exposed by these creation/activation tools.
- Account currency is used, with no currency conversion. Budgets accepted in integer micros are converted to exact decimal strings; reporting decimal strings already represent currency units.
- No server dry-run endpoint is used: previews are local and may still be rejected by LinkedIn for account eligibility, targeting, creative format, minimum bid, or budget restrictions.

Normalized analytics uses `timeGranularity=ALL`, explicit inclusive UTC start/end dates and one account per request. Fields: `costInLocalCurrency`, `impressions`, chargeable `clicks`, `externalWebsiteConversions`, and `conversionValueInLocalCurrency`. Attribution follows the advertiser's conversion rules; no arbitrary cross-provider attribution window is imposed.

## Professional-demographic reporting

`linkedin_demographic_report` reads account-scoped native analytics by company size, industry, seniority, job title, job function, country, region or company. It supports `ALL`, `DAILY`, `MONTHLY` and `YEARLY` periods, selected metrics, and an optional list of verified account-owned campaign IDs. Dates are inclusive UTC calendar dates. Returned periods are checked against the requested range; queries rounded by LinkedIn to wider month/year boundaries must be repeated with those explicit boundaries instead of being silently relabeled.

```json
{
  "account_id": "YOUR_ACCOUNT_ID",
  "pivot": "MEMBER_INDUSTRY",
  "date_range": { "start": "2026-10-01", "end": "2026-10-31" },
  "metrics": ["impressions", "clicks", "costInLocalCurrency"],
  "resolve_names": true,
  "limit": 100
}
```

Amounts remain exact native decimal strings in currency units. Missing metrics remain `null`; an absent row is not a zero. Conversion value, unique reach and carousel fields are not accepted for these demographic pivots. Structured `rows` retain native URNs, periods and numeric/decimal values; compact widget `records` include currency labels. No advertiser total is derived by adding the returned segments.

LinkedIn approximates these metrics, suppresses segments below three events, and limits each creative/day to its top 100 demographic values. Reporting can lag by 12–24 hours. `complete` therefore remains false even when `truncated` is false. Empty data can mean no activity or insufficient data access. The native endpoint does not support pagination and caps a response at 15,000 rows. Adport also reports a local row limit explicitly. Narrow the date/campaign selection when limited; there is no invented `start`, `count` or continuation cursor.

With `resolve_names`, one bounded `adTargetingEntities` lookup resolves up to the first 100 distinct returned URNs. A missing/denied optional name lookup preserves the analytics and original URNs without repeating the report. `linkedin_resolve_targeting_entities` performs the same exact `q=urns`, `QUERY_USES_URNS`, `SINGLE_NODE` lookup for up to 100 supplied taxonomy URNs, with optional locale. It verifies selected-account access and reports unresolved names; it does not expand descendants. One URN can appear under several native facets: Germany was live-verified under `locations`, `profileLocations`, `ipLocations` and `contextualCountries`. Native `elements` preserve those variants; `entities` and widget `records` group them by requested URN. Conflicting names remain explicit in `ambiguous_urns` and are not selected for report labels. Unrequested identities are rejected. Neither tool changes scopes, targeting, campaigns, money or delivery.

Contracts: [Reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-08), [metric and pivot schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-08), [targeting URN resolution](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/ads-targeting?view=li-lms-2026-08). These use Marketing API `202608`; the newer DMA pivot is not exposed by this versioned workflow.

## Conversion configuration and Insight Tags

`linkedin_insight_tags` reads the advertiser's single native Insight Tag, its associated accounts and first-party tracking flag. `linkedin_insight_tag_domains` reads account-scoped domain/callback diagnostics. Tag and pixel snippets remain inert structured text: widgets do not embed them, install site code, fetch pixels or send conversion events. An empty tag finder is a verified absence under LinkedIn's one-tag-per-account contract.

`linkedin_create_insight_tag` uses `expected_account_hash` from the current tag read and refuses an existing tag. Native creation defaults first-party tracking to true; the preview discloses that behavior. `linkedin_update_insight_tag` changes the flag using the current tag snapshot and verifies native readback. Because the flag propagates across all accounts sharing a tag, this single-account workflow rejects shared-tag flag changes until a dedicated multi-account authorization workflow is used. These tools do not grant/revoke tag access or change OAuth permissions.

`linkedin_conversions` lists account-owned rules, including disabled rules, with exact configuration and snapshot hashes. `include_shared=true` additionally requests native shared rules; those entries remain read-only and have no editable snapshot. `linkedin_get_conversion` reads one owned rule using both its ID and the selected account query. Foreign or mismatched identities reject. Offset paging preserves native metadata and advances by the actual native page width. Missing paging means unknown completeness, without an invented continuation.

Create a rule with `linkedin_create_conversion` and the current `expected_account_hash`. The default source is Insight Tag, and **enabled defaults to false**. Creation supplies explicit attribution windows/model and omits `autoAssociationType`, so the native default creates no campaign associations. Website rules support documented conversion types and 1/7/30-day windows; optional `url_match_rule_expression` uses an OR of AND groups, with `EXACT`, `STARTS_WITH` or `CONTAINS` matches. Omitting the expression creates an event-specific definition, without firing an event.

The `CONVERSIONS_API` source additionally supports native CAPI types, value handling and attribution windows. 180/365-day windows are restricted to their documented type set, including the Marketing/Sales Qualified Lead types available from `202608`. Native CAPI permission (`rw_conversions`, with the appropriate advertising access and account role) remains required; the existing advertising grant is not assumed to include it. No scope upgrade or event streaming happens automatically.

`linkedin_update_conversion` changes only supplied name, enabled state, type, windows, attribution model, value handling, exact-currency value or complete URL expression after matching `expected_snapshot_hash`. Monetary strings remain exact and must use the account currency. A supplied URL expression replaces that whole field; omitted fields, unknown native configuration and campaign associations remain unchanged. `NO_VALUE` stops using monetary values without silently deleting an omitted stored value. `enabled=false` disables a rule through native partial update; Adport does not invent a conversion-rule DELETE endpoint.

`linkedin_campaign_conversions` verifies campaign ownership and returns native association pages. `complete_snapshot=true` traverses up to 5,000 associations, rejecting duplicate, incomplete or foreign membership, and returns a complete `associations_snapshot_hash`; the widget displays at most 100 records. `linkedin_set_campaign_conversion` uses that hash and the conversion's current hash to associate or detach one owned rule with native composite-key PUT/DELETE. This changes measurement/optimization eligibility, while preserving campaign status and budgets. Detaching an association is reversible through the same tool.

All mutations use the ordinary shared preview/apply policy gate, recheck current settings, perform no automatic write retries and independently verify readback. Additive creation has `destructiveHint=false`; edits retain MCP's conservative modify-existing-data hint, which is independent of the CLI's read/write mode. An uncertain readback reports the resource ID for reconciliation; it does not imply the write failed. Native requests do not provide atomic compare-and-swap across the separate read and write.

Contracts: [Conversion tracking and campaign associations](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversion-tracking?view=li-lms-2026-08), [Conversions API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api?view=li-lms-2026-08), [CAPI schema and attribution limits](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema?view=li-lms-2026-08). Native live-test evidence is recorded separately from mocked contract tests.

## Text creatives and native images

`linkedin_creatives` provides an account-scoped, paged creative gallery using the native criteria finder. Text creatives include actual headline, description, destination and an owned image preview. `linkedin_get_creative` verifies both creative account and campaign hierarchy. Returned finder filters and page tokens are checked; a denied image read preserves the creative with a warning. With `include_media`, non-text creatives are hydrated through individual version `202610` metadata reads for native format, headline, introduction, ad line, primary asset URL and destination. `linkedin_creative_preview` provides the same native single-creative view. These metadata reads use the existing advertising grant; they do not confer Page-content access. Other reads and mutations retain version `202608`. Metadata is projected only on single-creative GETs; a finder's paging `metadata.nextPageToken` is a different object. Missing or denied enrichment preserves the source reference and reports the limit.

`linkedin_create_text_ad` creates native text content under a `TEXT_AD` campaign, paused by policy. It requires explicit non-political advertiser confirmation. Copy limits are 25 characters for the headline and 75 for the description. `linkedin_update_text_ad` merges supplied fields into the existing text content, preserving omitted image, copy and destination; unknown current content fields cause rejection rather than silent removal. Updates can trigger creative review. Native POST partial updates use `patch.$set`, and creation/copy/name/status mutations verify returned settings through a separate owned-resource read. A failed receipt retains the resource ID for reconciliation and is never retried automatically.

`linkedin_rename_creative` changes only the name. `linkedin_set_creative_status` pauses, activates or archives a creative; activation requires explicit non-political advertiser confirmation. The widget offers pause/archive actions without inferring that confirmation. Parent campaign delivery remains separate. The API can reject pausing an in-review creative; local preview does not guarantee provider acceptance.

`linkedin_delete_creative` sends native DELETE for a creative in DRAFT or under a DRAFT campaign. For other supported states it sets `PENDING_DELETION` and reports this as a request, rather than completed deletion. Already removed/canceled/pending resources are rejected. This does not remove the underlying sponsored post or image.

`linkedin_upload_image` reads checksum-bound local or project PNG/JPEG/GIF bytes, initializes an account-owned image and media-library entry, then transfers the exact bytes to the native LinkedIn upload URL after approval. Hosted calls require project media IDs. No upload is initialized during preview. Credentials are sent only to the reviewed native LinkedIn upload origin/path, with redirects disabled. Upload acceptance does not imply processing readiness: use `linkedin_get_library_image` and wait for `AVAILABLE`. Each ad format has its own dimensions and file-size requirements; text ads specify a 100×100 JPG/PNG of at most 2 MB. Images registered to a foreign account are rejected.

`linkedin_images` renders the selected account’s native image library with offset pagination. `linkedin_update_image` renames or archives/unarchives its library entry through a nested native partial update and verifies readback. Library archive changes visibility in that library; it does not delete bytes or pause ads using the image. Both the library finder and metadata update bind `associatedAccount` explicitly.

`linkedin_get_library_image` resolves one exact image through that account-scoped finder, including archived entries. Lookup and metadata readback verify membership on every page, reject repeated pages and stop at 5,000 images with an explicit incomplete-membership error. Library edits use this membership proof. `linkedin_get_image` remains a separate native individual-image request; its permissions can differ from the library finder, and a denied request is not retried through another identity or grant.

## Campaign groups, targeting and bids

`linkedin_get_campaign` and `linkedin_get_campaign_group` expose exact native settings with ownership checks. The create-group tool uses native DRAFT under `paused_creation`, and reports any ACTIVE-to-DRAFT coercion. LinkedIn documents group creation as ACTIVE or DRAFT, rather than PAUSED. DRAFT provides the non-serving initial state. Active group creation/activation requires explicit advertiser confirmation. Optional lifetime caps use micros and require an end date; the provider converts amounts to exact decimal strings in the account currency.

Named metadata tools edit campaign/group names and supplied schedule bounds, preserving the other bound and delivery status. Group names must fit 200 UTF-8 bytes. Group status affects every contained campaign. The group-budget tool changes an existing ordinary lifetime cap; dynamic shared group budgeting is explicitly rejected. `linkedin_set_bid` changes current campaign `unitCost` without switching its strategy or pricing model. It reads the current amount/currency for policy checks, rejects a group-managed dynamic bid, and compares money readback numerically in integer micros.

`linkedin_targeting_facets` exposes native facet discovery and supported finders. `linkedin_targeting_entities` browses supported facets, or uses native typeahead when `query` is supplied, with optional `entity_type`, `use_case`, locale and offset pagination. Location and profile-location facets require `query` after LinkedIn’s Bing Geo migration; returned locations must use modern `urn:li:geo` IDs. Missing or contradictory native paging produces unknown completeness rather than a false end-of-results claim. Continuation uses the requested page size only when native paging confirms it. Similar-entity searches and estimates remain separate. See the official [targeting finders](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/ads-targeting?view=li-lms-2026-08) and [pagination contract](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/pagination).

`linkedin_update_targeting` replaces supplied include clauses and preserves an omitted exclusion clause. Expansion changes must be explicit. Targeting requires exactly one modern geo facet with `urn:li:geo` IDs; unsupported current fields cause rejection. New custom/dynamic audience references are blocked until a dedicated account-availability workflow exists. Existing omitted exclusions remain preserved. Targeting previews display LinkedIn’s nondiscrimination notice.

Campaign/group deletion requires child-first cleanup to avoid stranded resources. Empty drafts use native DELETE; other eligible resources request `PENDING_DELETION` and report that state. The provider rejects already removed/canceled/pending resources. An accepted pending-deletion request does not prove final removal. All new writes use the shared exact-argument preview/apply gate, audit log, protected-account checks and budget policy.

These tools do not request new OAuth permissions. Advanced targeting typeahead/similar-entity discovery, audiences, conversion setup, lead-form authoring and dynamic shared group budgeting still need their own implementation, grant checks and live verification. The optional sponsored-post workflows below have additional native Page permission requirements. This is partial API coverage.

## Bid, budget and supply planning

`linkedin_budget_pricing` reads [Ad Budget Pricing](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ad-budget-pricing?view=li-lms-2026-08) using the selected account's actual currency, targeting, campaign type, bid type and explicit match mode. It returns native bid limits, suggested bids and daily budget limits as exact decimal Money amounts. Missing amounts remain unavailable. Sub-micro or very large native decimals are retained without rounding. For Sponsored Updates, LinkedIn describes a bid below the native minimum as potentially producing poor delivery; it is not universally a hard rejection threshold. For other supported formats, LinkedIn documents that minimum as a bid limit. A pricing read is not a campaign-creation validation.

`linkedin_supply_forecast` reads [Ad Supply Forecasts](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/ad-supply-forecasts?view=li-lms-2026-08) for an explicit future UTC start and exclusive end. Supply a daily and/or total budget in integer account-currency micros. Manual `NONE`/`ENHANCED_CONVERSION` forecasts require a complete `competing_bid`; auto-bidding omits it. Target-cost and cost-cap forecasts require their corresponding exact micro amount. Connected-television forecasts require Sponsored Updates and explicit Audience Network inclusion. A supplied campaign ID is checked for selected-account ownership. Native horizon, eligibility and objective/creative combinations can still be rejected by LinkedIn.

The planning API uses its own [objective and optimization codes](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ad-budget-pricing-type-combinations?view=li-lms-2026-08), including singular `WEBSITE_VISIT`, `WEBSITE_CONVERSION` and `VIDEO_VIEW`. These are not silently translated from campaign-creation codes. Current primary documentation uses both `JOB_APPLICATION` and `JOB_APPLICANT`; the exact selected value is sent, and native version rules still apply. The correctly documented impression optimization code is `MAX_IMPRESSION`. Targeting range URNs such as `urn:li:staffCountRange:(501,1000)` are encoded as leaf values within Rest.li structures, preserving their commas and parentheses safely.

Forecast output preserves native point estimates, low/high ranges and UTC period starts. `DAILY`, `SEVEN_DAY`, `THIRTY_DAY` and `CUSTOM` periods can overlap and must not be added together. `COST_PER_MILLION_*` values remain costs per one million results, and `*_PER_MILLION_IMPRESSIONS` retain that ratio scaling; they are not automatically CPC, CPM or CTR percentages. Unknown native metric types keep an explicit unknown-unit label. Missing values are not converted to zero. LinkedIn documents daily forecast spending up to 1.2 times the daily budget and possible zero estimates after a total budget is forecast to run out.

Both are named read-only tools in the single shared registry, with the existing project/account authorization boundary and no new grant. They create no pending write token and change no campaign, ad, budget, bid or delivery setting. Native partial responses are labeled. MCP hosts receive a read-only planning table, with local row pagination and the same exact amounts/units as the structured result. Widget pagination makes no additional provider or tool request. Neither a successful estimate nor an empty response proves campaign creation, billing readiness or creative eligibility.

## Sponsored content and shared post edits

`linkedin_create_sponsored_ad` uses `adAccounts/{account}/creatives?action=createInline` to create a text, image, video, document, article or carousel creative and its underlying dark post. It binds the explicit organization to the owned parent campaign's current `associatedEntity`, verifies the exact campaign format, and checks every referenced native media asset for selected-account membership and AVAILABLE processing status. Video ownership must also match the author organization. Articles use authored metadata rather than URL scraping. Carousel cards preserve order, titles, alternative text and per-card destinations. Lead-generation creation and reference reuse remain blocked until dedicated form ownership and single-use document rules are implemented.

The creative is coerced to PAUSED under `paused_creation`, with the coercion reported. LinkedIn's post contract still requires `lifecycleState=PUBLISHED` and `visibility=PUBLIC`; `feedDistribution=NONE`, empty external distribution and disabled resharing prevent organic feed distribution. This is **URL-accessible content**, not private storage or an unpublished draft post. Previews disclose this distinction before apply. Creating a dark post does not activate the paused creative or its campaign. Native Page authorization is checked by LinkedIn, and no server dry-run exists. Do not infer a successful native authorization from a local preview.

Creation checks both the returned creative status/ownership and the new native post's author, visibility, distribution, resharing, copy, media and processing lifecycle. Post readback requires native Page read permission; an advertising grant alone is not proof of it. Missing or inconsistent readback retains the known creative/post IDs and reports an error for reconciliation without replaying the create. PUBLISH_REQUESTED is reported as processing rather than completed publication.

`linkedin_create_reference_ad` reuses the post of another owned creative in the same account, under a campaign with the same organization and format. It sends the correct `content.documentAd.reference` for document campaigns and `content.reference` for the other supported formats. It creates no second post and leaves the source creative unchanged. Creation acknowledgments retain the native creative ID if readback fails; unknown writes are not replayed.

`linkedin_get_sponsored_post` accepts a creative ID, or a dark-post ID with an explicit organization tied to the current account/campaign association. It returns native post content, complete selected-account creative associations, and stable hashes for both. Full post reads additionally require `r_organization_social` and an eligible Page role. The existing advertising-only grant is not assumed to contain this scope. Post mutations additionally require native write permission, normally `w_organization_social`. These tools neither add scopes nor reauthorize a connection automatically.

The native post viewer renders actual copy, card titles, destinations and available account-library images/videos. Repeated carousel images remain in their original card positions. PDF titles and source IDs remain inspectable; a PDF is not embedded as executable content. Only an account-owned, feed-disabled dark post gets a bound shared-copy edit form. An organic post referenced by an ad remains read-only through this workflow.

`linkedin_update_sponsored_post` changes only supplied commentary, landing page, native CTA label or DSC name. It preserves omitted fields, media, author, distribution, lifecycle and creative delivery settings, then checks readback. The article source URL and media/title fields are immutable through this update contract; changed articles or media require replacement content. The widget exposes existing supported name, destination and CTA fields alongside commentary, and does not present an article's ignored `contentLandingPage` as a destination editor. It edits the shared source, so all linked creatives can be affected and may require review. The preview enumerates every association and binds both content and association hashes; concurrent copy, processing or linked-status changes require a fresh context and preview. Association queries check native account/reference filters and continuation tokens, reject repeated results, and fail explicitly if completeness cannot be established within 5,000 creatives.

`linkedin_archive_sponsored_post` uses the irreversible native `adContext.dscStatus=ARCHIVED` transition. LinkedIn cancels the linked creatives; the result distinguishes the acknowledged archive from requested downstream cancellation. `linkedin_delete_sponsored_post` permanently deletes only an account-owned dark post whose complete association list is empty or already REMOVED/CANCELED. Neither operation deletes the uploaded media. These destructive operations retain their own preview/apply pair and hashes; they are not invoked by ordinary copy edits.

## Video and PDF assets

`linkedin_media_context` reads the account's native organization reference. `linkedin_upload_video` requires that exact `owner_organization` and registers the upload in the selected account's media library. An optional owned `campaign_id` selects its native `associatedEntity` instead, for advertisers using a different Page. Ownership is rechecked at preview and apply. An absent organization reference stops the upload; the tools do not guess a Page or authenticated member. LinkedIn still checks native Page ADMIN/DSC permissions and advertising access when initializing. This workflow requests no broader OAuth grant.

The upload tool accepts checksum-bound MP4 bytes (75 kB–500 MB locally, up to the project library's 50 MiB hosted limit). Preview reads and verifies the source without initializing anything. Apply validates the entire native instruction set before sending any bytes, uses inclusive byte-range caps of at most 4 MiB (the final cap can extend past EOF; only actual source bytes are transferred), preserves ordered ETags, and finalizes the native upload. Part URLs must use the reviewed LinkedIn origin/path and selected video ID, and redirects are disabled. Video part capabilities receive no OAuth token. Document upload paths are opaque outputs of native initialization; they must remain under the reviewed HTTPS LinkedIn origin and DMS upload path, without redirects or embedded credentials. A failed or uncertain stage retains the initialized video ID and is never automatically retried. Captions, custom thumbnails and member-owned uploads remain separate extensions.

`linkedin_videos` renders account-library video previews and processing status with bound name/archive actions and offset pagination. `linkedin_get_library_video` resolves one exact video, including archived entries, with a 5,000-entry bound and repeated-page checks. Its `library_snapshot_hash` covers identity, owner, processing status and account-library metadata; expiring preview URLs do not invalidate an approval. `linkedin_update_video` uses that hash and native nested partial updates, checks archive/unarchive processing constraints, and verifies metadata readback. Library archive does not delete the asset or alter existing posts or ad delivery.

`linkedin_upload_document` uploads PDF bytes owned by the selected sponsored account. The project media library and headless CLI support PDF files; use `media_upload`, or prepare/PUT-or-MCP-parts/finalize, before a hosted provider upload. Local uploads allow up to 100 MB; hosted files remain limited to 50 MiB. File signatures, size and checksum are checked locally; LinkedIn validates PDF structure and its 300-page limit during processing. `name` labels the approved source; the Documents API does not receive a fabricated rename field. Office documents and organization/member-owned uploads remain separate work. `linkedin_get_document` verifies the native document owner matches the selected account before returning processing status and temporary download links. Sponsored document-ad creation is a separate guarded operation.

Both upload tools return `UPLOAD_ACCEPTED` with `processing_complete: false`. Follow the returned read tool until native `AVAILABLE`; an accepted transfer is not proof of processing success. Uploading an asset creates no post, creative, campaign, or serving association. There is no fabricated media DELETE endpoint: source deletion, library archive and post/ad lifecycle actions remain distinct.

The current analytics endpoint does **not** support pagination and returns at most 15,000 elements. Results at that ceiling are marked potentially truncated. Older ALL queries can be expanded to month boundaries by LinkedIn; Adport checks returned dates and refuses to label an expanded period as the requested range. Missing metrics stay absent. An empty analytics response can mean no activity **or** insufficient reporting access; account discovery alone does not prove reporting permission.

## Saved audience templates

`linkedin_saved_audiences` uses the native account finder, sort and Rest.li
offset pagination. It verifies the selected advertiser, returns
`account_snapshot_hash` for creation and a snapshot for each template, and keeps
native reach estimates approximate. Missing paging metadata leaves collection
completeness unknown. `linkedin_get_saved_audience` verifies one exact template
and returns the snapshot required for edits or deletion.

`linkedin_create_saved_audience` requires `expected_account_hash` from the list
response. `linkedin_update_saved_audience` and
`linkedin_delete_saved_audience` require `expected_snapshot_hash`. Creation and
updates are independently read back before success is reported. Names allow up
to 100 characters, descriptions up to 500. An empty description clears its text;
supplied targeting criteria replaces the entire definition and omitted fields
are preserved. Account and read-only fields cannot be edited. Reviews show only
observed previous values, leaving missing ones unspecified.

These are saved targeting definitions, rather than contact-list uploads.
Applying criteria to a campaign uses the separate guarded campaign update.
Existing `r_ads`/`rw_ads` permissions and the native advertiser role remain
authoritative; a viewer cannot write. All mutations use preview/apply approval,
and writes are never retried automatically. Native deletion requires 204 and has
no restore endpoint. An uncertain create/update retains any returned template ID
for reconciliation before another request.

Contracts checked on 2026-11-04 against LinkedIn's [saved-audience templates](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/saved-audience-templates?view=li-lms-2026-08)
and [Rest.li pagination](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/pagination).
Mock wire tests do not establish live grant eligibility or successful writes.

## Official contract sources

Core contracts reviewed 2026-08-31; sponsored content and descriptive metadata reviewed 2026-11-04. Requests pin `Linkedin-Version: 202608` and `X-Restli-Protocol-Version: 2.0.0`; individual creative metadata reads explicitly use `202610`.

- [Account schema and cursor search](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-08)
- [Campaign schema, creation, budget updates and consent requirements](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-08)
- [Campaign groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-08)
- [Creatives, native status/deletion and criteria finder](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-08)
- [Individual creative descriptive metadata](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-10#retrieve-creative-metadata)
- [Posts, dark content and supported partial updates](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-08) and [native schema/CTA labels](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema?view=li-lms-2026-08)
- [Sponsored document content](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/document-ads?view=li-lms-2026-08), [ordered carousel cards](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/carousel-ads-integrations?view=li-lms-2026-08), and [campaign format mapping](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/campaign-objectives?view=li-lms-2026-08)
- [Text-ad creation and content updates](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/text-ads-integrations?view=li-lms-2026-08)
- [Native images and media-library metadata](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-08)
- [Native multipart videos, readiness and library updates](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-08)
- [Native document upload and ownership](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2026-08)
- [Targeting criteria structure](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria)
- [Reporting behavior](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-08) and [metric response schemas](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-08)
- [Rest.li URL encoding](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version)
- [Authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) and [programmatic refresh](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

Rejected API requests expose only allowlisted machine diagnostics: HTTP/native/service codes, validation field paths, numeric limits and a provider correlation ID when returned. Free-form messages, descriptions and submitted values are omitted, credential echoes are excluded, and error bodies are bounded. Native failures are not retried automatically. See [LinkedIn's error schema](https://learn.microsoft.com/en-us/linkedin/marketing/error-responses?view=li-lms-2026-08).

Tests use synthetic fixtures shaped by these references and assert outgoing URLs, headers, bodies, response contracts and policy behavior. On 2026-11-03, an existing scoped hosted grant uploaded a private QA image through Claude's native approval widget; the account-library finder confirmed ownership and AVAILABLE status, and the gallery supported a verified library rename. The individual-image endpoint returned403. On 2026-11-04, headless PDF source staging and a native document upload/readback reached AVAILABLE. A separate paused campaign creation preview passed locally, but its native apply returned422 without an ID; the older client did not retain the validation details. This does not establish campaign or sponsored-post creation support for that live grant. Native metadata202610, sponsored formats, shared post edits and other management operations still require live verification. A local LinkedIn credential is unavailable.

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
- Normalized reports for account, campaign and creative (`ad`) levels. LinkedIn has no native ad-group entity; `ad_group` is rejected explicitly rather than duplicating campaign data. Campaign groups can be listed separately.
- Guarded campaign creation under an existing campaign group; paused creation, exact decimal money, and account/group ownership checks. This creates the campaign only, not creatives, lead forms or a complete serving campaign hierarchy.
- Guarded campaign status and existing daily/total budget updates using Rest.li partial updates. Group-shared dynamic budget creation is rejected because its policy semantics differ from ordinary campaign budgets.
- Explicit non-political advertiser confirmation for creation and activation. Creation previews carry LinkedIn's targeting nondiscrimination notice. Do not infer consent on the advertiser's behalf. Political campaigning is not exposed by these creation/activation tools.
- Account currency is used, with no currency conversion. Budgets accepted in integer micros are converted to exact decimal strings; reporting decimal strings already represent currency units.
- No server dry-run endpoint is used: previews are local and may still be rejected by LinkedIn for account eligibility, targeting, creative format, minimum bid, or budget restrictions.

Analytics uses `timeGranularity=ALL`, explicit inclusive UTC start/end dates and one account per request. Fields: `costInLocalCurrency`, `impressions`, chargeable `clicks`, `externalWebsiteConversions`, and `conversionValueInLocalCurrency`. Attribution follows the advertiser's conversion rules; no arbitrary cross-provider attribution window is imposed.

## Text creatives and native images

`linkedin_creatives` provides an account-scoped, paged creative gallery using the native criteria finder. Text creatives include actual headline, description, destination and an owned image preview. `linkedin_get_creative` verifies both creative account and campaign hierarchy. Returned finder filters and page tokens are checked; a denied image read preserves the creative with a warning. API version `202608` returns sponsored-post content references instead of enriched post copy. These references are retained explicitly; a reference alone is not a rendered creative or a verified authoring flow for image/video/carousel posts.

`linkedin_create_text_ad` creates native text content under a `TEXT_AD` campaign, paused by policy. It requires explicit non-political advertiser confirmation. Copy limits are 25 characters for the headline and 75 for the description. `linkedin_update_text_ad` merges supplied fields into the existing text content, preserving omitted image, copy and destination; unknown current content fields cause rejection rather than silent removal. Updates can trigger creative review. Native POST partial updates use `patch.$set`, and creation/copy/name/status mutations verify returned settings through a separate owned-resource read. A failed receipt retains the resource ID for reconciliation and is never retried automatically.

`linkedin_rename_creative` changes only the name. `linkedin_set_creative_status` pauses, activates or archives a creative; activation requires explicit non-political advertiser confirmation. The widget offers pause/archive actions without inferring that confirmation. Parent campaign delivery remains separate. The API can reject pausing an in-review creative; local preview does not guarantee provider acceptance.

`linkedin_delete_creative` sends native DELETE for a creative in DRAFT or under a DRAFT campaign. For other supported states it sets `PENDING_DELETION` and reports this as a request, rather than completed deletion. Already removed/canceled/pending resources are rejected. This does not remove the underlying sponsored post or image.

`linkedin_upload_image` reads checksum-bound local or project PNG/JPEG/GIF bytes, initializes an account-owned image and media-library entry, then transfers the exact bytes to the native LinkedIn upload URL after approval. Hosted calls require project media IDs. No upload is initialized during preview. Credentials are sent only to the reviewed native LinkedIn upload origin/path, with redirects disabled. Upload acceptance does not imply processing readiness: use `linkedin_get_library_image` and wait for `AVAILABLE`. Each ad format has its own dimensions and file-size requirements; text ads specify a 100×100 JPG/PNG of at most 2 MB. Images registered to a foreign account are rejected.

`linkedin_images` renders the selected account’s native image library with offset pagination. `linkedin_update_image` renames or archives/unarchives its library entry through a nested native partial update and verifies readback. Library archive changes visibility in that library; it does not delete bytes or pause ads using the image. Both the library finder and metadata update bind `associatedAccount` explicitly.

`linkedin_get_library_image` resolves one exact image through that account-scoped finder, including archived entries. Lookup and metadata readback verify membership on every page, reject repeated pages and stop at 5,000 images with an explicit incomplete-membership error. Library edits use this membership proof. `linkedin_get_image` remains a separate native individual-image request; its permissions can differ from the library finder, and a denied request is not retried through another identity or grant.

## Campaign groups, targeting and bids

`linkedin_get_campaign` and `linkedin_get_campaign_group` expose exact native settings with ownership checks. The create-group tool uses native DRAFT under `paused_creation`, and reports any ACTIVE-to-DRAFT coercion. LinkedIn documents group creation as ACTIVE or DRAFT, rather than PAUSED. DRAFT provides the non-serving initial state. Active group creation/activation requires explicit advertiser confirmation. Optional lifetime caps use micros and require an end date; the provider converts amounts to exact decimal strings in the account currency.

Named metadata tools edit campaign/group names and supplied schedule bounds, preserving the other bound and delivery status. Group names must fit 200 UTF-8 bytes. Group status affects every contained campaign. The group-budget tool changes an existing ordinary lifetime cap; dynamic shared group budgeting is explicitly rejected. `linkedin_set_bid` changes current campaign `unitCost` without switching its strategy or pricing model. It reads the current amount/currency for policy checks, rejects a group-managed dynamic bid, and compares money readback numerically in integer micros.

`linkedin_targeting_facets` and `linkedin_targeting_entities` expose native facet discovery and the facet finder’s entity choices, with locale and offset pagination. Typeahead/similar-entity searches and estimates remain separate. `linkedin_update_targeting` replaces supplied include clauses and preserves an omitted exclusion clause. Expansion changes must be explicit. Targeting requires exactly one modern geo facet with `urn:li:geo` IDs; unsupported current fields cause rejection. New custom/dynamic audience references are blocked until a dedicated account-availability workflow exists. Existing omitted exclusions remain preserved. Targeting previews display LinkedIn’s nondiscrimination notice.

Campaign/group deletion requires child-first cleanup to avoid stranded resources. Empty drafts use native DELETE; other eligible resources request `PENDING_DELETION` and report that state. The provider rejects already removed/canceled/pending resources. An accepted pending-deletion request does not prove final removal. All new writes use the shared exact-argument preview/apply gate, audit log, protected-account checks and budget policy.

These tools do not request new OAuth permissions. Company Page content, inline sponsored posts, advanced targeting discovery/estimates, audiences, conversion setup and dynamic shared group budgeting need their own implementation, grant checks and live verification. This is partial API coverage.

## Video and PDF assets

`linkedin_media_context` reads the account's native organization reference. `linkedin_upload_video` requires that exact `owner_organization` and registers the upload in the selected account's media library. An optional owned `campaign_id` selects its native `associatedEntity` instead, for advertisers using a different Page. Ownership is rechecked at preview and apply. An absent organization reference stops the upload; the tools do not guess a Page or authenticated member. LinkedIn still checks native Page ADMIN/DSC permissions and advertising access when initializing. This workflow requests no broader OAuth grant.

The upload tool accepts checksum-bound MP4 bytes (75 kB–500 MB locally, up to the project library's 50 MiB hosted limit). Preview reads and verifies the source without initializing anything. Apply validates the entire native instruction set before sending any bytes, uses exact inclusive byte ranges of at most 4 MiB, preserves ordered ETags, and finalizes the native upload. Part URLs must use the reviewed LinkedIn origin/path and selected video ID, and redirects are disabled. Video part capabilities receive no OAuth token. A failed or uncertain stage retains the initialized video ID and is never automatically retried. Captions, custom thumbnails and member-owned uploads remain separate extensions.

`linkedin_videos` renders account-library video previews and processing status with bound name/archive actions and offset pagination. `linkedin_get_library_video` resolves one exact video, including archived entries, with a 5,000-entry bound and repeated-page checks. Its `library_snapshot_hash` covers identity, owner, processing status and account-library metadata; expiring preview URLs do not invalidate an approval. `linkedin_update_video` uses that hash and native nested partial updates, checks archive/unarchive processing constraints, and verifies metadata readback. Library archive does not delete the asset or alter existing posts or ad delivery.

`linkedin_upload_document` uploads PDF bytes owned by the selected sponsored account. The project media library and headless CLI support PDF files; use `media_upload` or prepare/PUT/finalize before a hosted provider upload. Local uploads allow up to 100 MB; hosted files remain limited to 50 MiB. File signatures, size and checksum are checked locally; LinkedIn validates PDF structure and its 300-page limit during processing. `name` labels the approved source; the Documents API does not receive a fabricated rename field. Office documents, organization/member-owned documents and document-post authoring are still separate work. `linkedin_get_document` verifies the native document owner matches the selected account before returning processing status and temporary download links.

Both upload tools return `UPLOAD_ACCEPTED` with `processing_complete: false`. Follow the returned read tool until native `AVAILABLE`; an accepted transfer is not proof of processing success. Uploading an asset creates no post, creative, campaign, or serving association. There is no fabricated media DELETE endpoint: source deletion, library archive and post/ad lifecycle actions remain distinct.

The current analytics endpoint does **not** support pagination and returns at most 15,000 elements. Results at that ceiling are marked potentially truncated. Older ALL queries can be expanded to month boundaries by LinkedIn; Adport checks returned dates and refuses to label an expanded period as the requested range. Missing metrics stay absent. An empty analytics response can mean no activity **or** insufficient reporting access; account discovery alone does not prove reporting permission.

## Official contract sources

Reviewed 2026-08-31; requests pin `Linkedin-Version: 202608` and `X-Restli-Protocol-Version: 2.0.0`.

- [Account schema and cursor search](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-08)
- [Campaign schema, creation, budget updates and consent requirements](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-08)
- [Campaign groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-08)
- [Creatives, native status/deletion and criteria finder](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-08)
- [Text-ad creation and content updates](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/text-ads-integrations?view=li-lms-2026-08)
- [Native images and media-library metadata](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-08)
- [Native multipart videos, readiness and library updates](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-08)
- [Native document upload and ownership](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2026-08)
- [Targeting criteria structure](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria)
- [Reporting behavior](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-08) and [metric response schemas](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-08)
- [Rest.li URL encoding](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version)
- [Authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) and [programmatic refresh](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

Tests use synthetic fixtures shaped by these references and assert outgoing URLs, headers, bodies, response contracts and policy behavior. On 2026-11-03, an existing scoped hosted grant uploaded a private QA image through Claude's native approval widget. The account-library finder confirmed its name, ownership and AVAILABLE status, and Claude decoded its 640×640 preview and rendered the edit form. The individual-image endpoint returned403. Metadata edits, text-ad creation, advanced formats and broader management still require live verification; successful upload/library access does not establish those capabilities. A local LinkedIn credential is unavailable.

# Apple campaign setup

All writes below require a preview followed by the same arguments plus the returned `pending_operation_id`. No write bypasses policy or audit logging. Apple has no server dry-run; previews are local plans, not provider validation.

| Task | Tool | Notes |
| --- | --- | --- |
| Inspect bids, Search Match, devices and status | `apple_adgroups` | Query with `campaignId` filter or get `resource_id`. |
| Inspect keyword match types, bids and status | `apple_keywords` | Query with `adGroupId` filter. |
| Inspect exclusions | `apple_negative_keywords` | Query by campaign or ad group. |
| Create a keyword list | `apple_create_keywords` | Up to 100 items in one preview/apply pair; omit bid/currency together to inherit. |
| Add discovery/irrelevant-search exclusions | `apple_create_negative_keywords` | Exactly one `campaign_id` or `ad_group_id`. Exclusions stay ENABLED because they prevent delivery. |
| Set campaign end date | `apple_set_campaign_schedule` | UTC `YYYY-MM-DDTHH:mm:ss.SSS` (optional Z). Omitted fields stay unchanged; status is not changed. |
| Inspect default and custom ads | `apple_ads`, `apple_creatives` | Full provider responses, including system status and destination. |
| Find custom product pages | `apple_product_pages` | Query provider filters or fetch a known page ID. |
| Create a product page creative | `apple_create_creative` | `adam_id` plus optional custom `product_page_id`. |
| Link a creative to an ad group | `apple_create_ad` | Use a VALID creative; new ads default to PAUSED. |
| Choose App Store placement | `apple_create_campaign` | Search results, Search tab, Today tab or Product pages; App Store supply source is explicit. |
| Create an ad group | `apple_create_ad_group` | Requires an explicit UTC `start_time`; pricing and bid use the native CPT/Money fields. |
| Change targeting | `apple_update_targeting` | Campaign country/placement or ad-group audience, device, geo and schedule dimensions. Omitted dimensions stay unchanged; supplied dimensions replace their lists. Supply source is immutable. |
| Change Search Match | `apple_set_search_match` | Refuses disabling it when Apple marks automated keywords as required. |
| Rename ads or creatives | `apple_update_ad`, `apple_update_creative` | Does not change status or ad-to-creative association. |
| Remove an entity | `apple_delete_resource` | Checks the selected account and exact resource first. Default product-page creatives cannot be deleted. |

## Discovery, reports and recommendations

| Tool | Apple v1 endpoint | Behavior |
| --- | --- | --- |
| `apple_search_apps` | `GET search/apps` | Owned apps, name/ID search and storefronts. |
| `apple_search_geo` | `GET search/geo` | App Store/Maps location IDs and eligibility. |
| `apple_app_eligibility` | `POST eligibilities/apps/query` | Uses the scalar numeric Adam ID required by this endpoint. |
| `apple_supported_languages` | `POST metadata/apps/supported-languages/query` | Language and locale metadata. |
| `apple_report` | `POST reports/apps/{entity}/query` | Campaign, ad-group, ad, keyword and search-term rows with native metadata, granular metrics, filters and pagination. Child entities require `campaign_id`. |
| `report` | App Store campaign/ad-group/ad report endpoints | Normalized account/campaign/ad-group/ad metrics. Child queries discover campaigns first. Unavailable revenue and suppressed metrics remain absent; capped results are marked truncated. |
| `apple_recommendations` | `POST recommendations/{category}/query` | Budget/target-CPA recommendations scoped to an explicit app or brand; no application. |
| `apple_suggestions` | `POST suggestions/{category}/query` | Keyword, phrase, category or target-CPA discovery. Phrase/category discovery sets `queryType: SUGGESTION`. |
| `apple_search_suggestions` | `POST suggestions/{category}/query` | Exact phrase/category popularity or partial search using `queryType: SEARCH`. |
| `apple_impression_share` | `POST insights/apps/impression-share/query` | Native UTC share/rank data; the promoted-object filter uses `IN`. |
| `apple_search_term_popularity` | `POST insights/apps/search-term-popularity/query` | Weekly/monthly popularity and optional ranking fields. |
| `apple_change_history` | `POST change-history/query` | Requires explicit entity types and a UTC event-time range. |

Search-term reports require account time (`ORTZ`), reject hourly granularity and cannot include empty metric rows. Ad reports also reject hourly granularity. Keyword/search-term breakdowns allow device and country; ad breakdowns allow country only. Native responses preserve suppressed terms and provider errors rather than inventing metrics.

`apple_assets`, `apple_business_brands`, `apple_locations`, `apple_location_groups` and `apple_shared_budgets` preserve the native query response. Business Brand/Maps access is gated by Apple's account permissions and product features; an App Store grant alone does not provide it.

For an authorized Maps account, `apple_create_location_group` creates static membership or dynamic rules; `apple_update_location_group` changes membership within its current type. `apple_create_brand_campaign` supports MAX_ENGAGEMENTS, MANUAL_CPT and MANUAL_CPM with policy-checked budgets. `apple_create_brand_ad_group` inherits pricing/bidding from that campaign and verifies each location group's brand and VALID status. `apple_create_brand_creative` binds brand-owned asset IDs to localized promotional copy and the Maps place-card destination; `apple_create_ad` links a valid creative afterward. These write shapes have request-level tests against Apple's [Maps workflow](https://developer.apple.com/documentation/apple-ads-platform-api/journey-apple-maps-brand-ads); the existing local grant rejects Business Brand access, so live Maps write verification is still pending.

## Creative editing boundaries

Creative cards expose actual type, destination and status with account-bound rename/status forms. Each form requests a new preview before applying. Ads are hydrated from their referenced creative IDs. Product-page creatives can provide a destination without a media preview.

Apple allows only one default product-page creative per app/account. Read `apple_creatives` and reuse that ID. Its visual assets and copy come from App Store Connect; `creativeSpec` is intentionally empty and cannot edit the store listing. Maps creative cards display localized promotional copy; `apple_update_brand_creative_copy` changes one existing locale while preserving assets, format and other locales. `apple_update_creative` can replace the complete native Business Brand creative spec. Both content operations may affect every ad sharing the creative and require review. Creative association is immutable on an ad; another association requires another paused ad.

Live checks on 2026-11-03 verified native reads, paused campaign/ad-group/keyword creation, targeting, Search Match, creative rename, keyword bid/status updates, and Search Tab ad creation/rename/status. Apple rejected explicit ad creation under the tested Search Results campaign even though its general guide describes the ad workflow. It also rejected individual deletion of default-product-page ads; remove the parent ad group or pause delivery. Do not treat an API-shaped tool as proof of placement or account eligibility.

List reads accept `filters`, `offset`, and `limit`. The newer discovery/report tools support native filter operators and scalar or array values; the original ad-group/keyword/product-page tools accept EQUALS with an array. Responses preserve pagination so agents can fetch subsequent pages. Account discovery fetches each account's currency and timezone without guessing.

Batch creation sets `allowPartialSuccess: false`. If Apple nevertheless returns an item failure, Adport surfaces it as a provider error; read back before retrying rather than duplicating successful items.

Custom product page assignment uses Apple's creative workflow: query pages, create the creative, read its status until VALID, then create the paused ad. Creating a creative does not publish or enable an ad. The default ad can be inspected with `apple_ads`.

Wire contracts verified against Apple's Ads Platform API documentation on 2026-10-24: [bulk keywords](https://developer.apple.com/documentation/apple-ads-platform-api/post-keywords-bulk-create), [negative keywords](https://developer.apple.com/documentation/apple-ads-platform-api/negativekeywordcreate), [campaign updates](https://developer.apple.com/documentation/apple-ads-platform-api/campaignupdate), [creatives](https://developer.apple.com/documentation/apple-ads-platform-api/creativecreate), and [account metadata](https://developer.apple.com/documentation/apple-ads-platform-api/adaccount).

The reporting and discovery extension was checked against the [official Node SDK](https://github.com/apple/apple-ads-platform-api-node/tree/e81717d119c565048f3689416f453c2465a905ec), [report endpoints](https://developer.apple.com/documentation/apple-ads-platform-api/apps-reports-endpoints), [suggestions](https://developer.apple.com/documentation/apple-ads-platform-api/suggestions-endpoints) and [insights](https://developer.apple.com/documentation/apple-ads-platform-api/insights-endpoints), plus existing-account responses on 2026-11-03. These contracts apply to v1; the legacy v5 API retires on 2027-01-26.

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

List reads accept `filters` (`field`, `operator: EQUALS`, `value` array), `offset`, and `limit`. Responses preserve pagination so agents can fetch subsequent pages instead of assuming the first page is complete. Account discovery fetches each account's currency and timezone from its account details, without guessing USD or a local timezone.

Batch creation sets `allowPartialSuccess: false`. If Apple nevertheless returns an item failure, Adport surfaces it as a provider error; read back before retrying rather than duplicating successful items.

Custom product page assignment uses Apple's creative workflow: query pages, create the creative, read its status until VALID, then create the paused ad. Creating a creative does not publish or enable an ad. The default ad can be inspected with `apple_ads`.

Wire contracts verified against Apple's Ads Platform API documentation on 2026-10-24: [bulk keywords](https://developer.apple.com/documentation/apple-ads-platform-api/post-keywords-bulk-create), [negative keywords](https://developer.apple.com/documentation/apple-ads-platform-api/negativekeywordcreate), [campaign updates](https://developer.apple.com/documentation/apple-ads-platform-api/campaignupdate), [creatives](https://developer.apple.com/documentation/apple-ads-platform-api/creativecreate), and [account metadata](https://developer.apple.com/documentation/apple-ads-platform-api/adaccount).

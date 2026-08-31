# Spotify Ads provider

## Local connection

Create your own app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard), select **Ads API**, and register `http://127.0.0.1:53685/callback`. Accept the Ads API terms in Ads Manager for that client ID; allowlisting may take one hour. See the [official quickstart](https://developer.spotify.com/documentation/ads-api/quick-start).

Supply `SPOTIFY_CLIENT_SECRET` securely through your terminal environment, then run `adport connect spotify` (or `--no-browser` to open the authorization link yourself). The wizard asks for the client ID and exact local callback, verifies account discovery, and stores credentials in the local permission-restricted credential store. Reconnection reuses complete stored client credentials. No shared Adport app is required for this local flow.

Unattended use supports the complete set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`. Complete stored credentials take precedence. Refresh-token rotation is persisted for store-backed connections. Do not commit credentials or paste them into logs.

## Supported operations

- Normalized account discovery and account/campaign/ad-group/ad reporting.
- `spotify_list_campaigns`, `spotify_get_ad_set`.
- `spotify_create_campaign_draft`: creates an **unpublished** draft with an explicit paused status under the normal paused-creation policy. This is not a published campaign or a launched ad.
- `spotify_set_campaign_status`: pause/activate an existing published campaign.
- `spotify_set_budget`: update an ad set's budget, retaining its DAILY/LIFETIME type.
- `spotify_set_ad_set_delivery`: turn delivery OFF/ON, sent as the sole PATCH field.

Every mutation uses the shared preview → identical arguments + pending token → apply gate. Preview is local; these tools do not claim server validation. Direct campaign creation is intentionally not exposed: its documented request lacks a status field, so it cannot guarantee paused creation. Publishing a complete draft hierarchy, ad/asset creation, audience editing, and deletion are not implemented by this module yet.

## Wire contract and tests

Reviewed against official Spotify Ads API v3 documentation on 2026-08-31:

| Contract | Official reference | Assertions |
| --- | --- | --- |
| OAuth | [Quickstart](https://developer.spotify.com/documentation/ads-api/quick-start) | Basic client authentication, form code/refresh exchange, bearer tokens, empty Ads scope rather than music scopes |
| Businesses | [getBusinesses](https://developer.spotify.com/documentation/ads-api/reference/v3.0/getBusinesses) | `businesses` envelope and UUIDs |
| Account discovery | [getAdAccountsInBusiness](https://developer.spotify.com/documentation/ads-api/reference/v3.0/getAdAccountsInBusiness) | `ad_accounts`, currency_code, status, no invented pagination |
| Campaign listing | [getCampaigns](https://developer.spotify.com/documentation/ads-api/reference/v3.0/getCampaigns) | limit/offset requests, paging metadata and campaign objects |
| Campaign updates | [updateCampaign](https://developer.spotify.com/documentation/ads-api/reference/v3.0/updateCampaign) | Account-scoped PATCH with JSON status only |
| Draft creation | [createCampaignDraft](https://developer.spotify.com/documentation/ads-api/reference/v3.0/createCampaignDraft) | Draft path, delivery_goal_group, explicit PAUSED request, account/status response checks |
| Ad-set reads | [getAdSetById](https://developer.spotify.com/documentation/ads-api/reference/v3.0/getAdSetById) | ID, campaign ID, budget object, delivery |
| Ad-set updates | [updateAdSet](https://developer.spotify.com/documentation/ads-api/reference/v3.0/updateAdSet) | budget.micro_amount integer micros; preserve type; delivery-only PATCH |
| Reporting | [getAggregateReport](https://developer.spotify.com/documentation/ads-api/reference/v3.0/getAggregateReport) | Repeated fields, LIFETIME aggregation, UTC inclusive dates, continuation-only subsequent requests, typed rows/stats, suppression sentinel |
| Metric definitions | [Metrics glossary](https://developer.spotify.com/documentation/ads-api/guides#metrics-glossary) | PURCHASES → conversions, REVENUE → conversion_value; derived ratios from base metrics |

Report SPEND is already in normal currency units, unlike write budgets in micros. Reports select only requested metric dependencies. Missing and privacy-suppressed (`-5`) metrics remain absent; CPA cannot be computed from suppressed purchases. Spotify attribution remains provider-defined, not artificially harmonized across platforms. Explicit report date ranges must be ordered and within 90 days. Results exceeding the requested limit are marked truncated, not silently described as complete.

The reference's generated campaign example contains placeholder zero paging counts beside a sample campaign, and its reporting `warnings` example contains row objects despite being documented as strings. Tests preserve documented field contracts but use coherent synthetic paging values and do not depend on the contradictory warnings example.

These are documentation-grounded mocked wire tests, **not live API verification**. Live account discovery/reporting awaits an authorized, allowlisted app. Spotify NO_DELIVERY_NO_BILLING test accounts cannot produce delivery metrics; empty reports are expected there. Cloud OAuth approval is separate from local module implementation.

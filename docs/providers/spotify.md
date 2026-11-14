# Spotify Ads provider

## Local connection

Create your own app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard), select **Ads API**, and register `http://127.0.0.1:53685/callback`. Accept the Ads API terms in Ads Manager for that client ID; allowlisting may take one hour. See the [official quickstart](https://developer.spotify.com/documentation/ads-api/quick-start).

Supply `SPOTIFY_CLIENT_SECRET` securely through your terminal environment, then run `adport connect spotify` (or `--no-browser` to open the authorization link yourself). The wizard asks for the client ID and exact local callback, verifies account discovery, and stores credentials in the local permission-restricted credential store. Reconnection reuses complete stored client credentials. No shared Adport app is required for this local flow.

Unattended use supports the complete set `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`. Complete stored credentials take precedence. Refresh-token rotation is persisted for store-backed connections. Do not commit credentials or paste them into logs.

## Supported operations

- Account discovery, normalized reporting, native insight reports, report export/status and campaign/ad-set reads.
- Create, edit, validate and delete unpublished campaign/ad-set/ad drafts; copy published configurations into drafts; publish a validated hierarchy subject to paused-creation policy and independent native readback. Publishing is a separate guarded action.
- Upload, inspect and rename creative assets; manage draft creatives and targeting using local files or verified project media.
- Audience configuration, lookalikes, targeting options, geography, audience estimates and bid estimates.
- Published campaign status, ad-set budgets and delivery. Budget changes retain DAILY/LIFETIME type; delivery changes send the delivery field alone.
- Account-scoped Pixel, CAPI integration, dataset and mobile-app measurement configuration, sharing, diagnostics and signed creation reconciliation. These operations do not install tracking or send conversion events.
- Private CAPI credential metadata, provisioning, storage and revocation, described below.

Every mutation uses the shared preview → identical arguments + pending token → apply gate. Preview is local; these tools do not claim server validation. Direct campaign creation is intentionally not exposed: its documented request lacks a status field, so it cannot guarantee paused creation. The supported creation path uses drafts. Native permissions, eligibility and format requirements remain authoritative.

## Private CAPI credentials

Use `spotify_capi_credentials` with `account_id` and `dataset_id` to read credential IDs, creation times, storage status and fresh configuration/inventory hashes. Before contacting the native token endpoint, Adport verifies the account's business, its dataset access, sharing restricted to this selected account and the exact CAPI parent/child binding. Business-wide token inventory and token values are not exposed to agents.

`spotify_create_capi_credential` creates one long-lived native token and stores it privately. `spotify_store_capi_credential` stores one explicitly selected existing native credential without issuing another. Both require `acknowledge_credential_access: true` and the three current hashes from the metadata read. Spotify's GET endpoint returns token values as well as metadata; Adport keeps those values inside the provider and returns metadata only. The native creation endpoint has no configurable expiry field, so Adport does not invent one.

The local CLI/MCP factory uses separate files under `ADPORT_HOME/resource-credentials`, with directory mode `0700`, file mode `0600` and atomic, exclusive creation. Hosted Adport stores authenticated ciphertext in an unexposed private table, bound to the project and complete resource scope. Browser roles have no table privileges. Resource secrets do not share an OAuth credential row, so reconnecting or refresh-token rotation cannot overwrite them. Direct provider construction must inject a private `ResourceSecretStore` before credential mutations are available.

`spotify_revoke_capi_credential` requires the selected credential ID, fresh hashes and `acknowledge_ingestion_effects: true`. Revocation can stop existing event publishers. It confirms that the token is no longer active before removing its local copy. If native revocation succeeded but confirmation or cleanup failed, a fresh metadata read and preview can remove the inactive local copy without issuing another native DELETE. Secrets are never included in previews, pending operations, results or audit entries.

Configuration, sharing and inventory are checked again at apply. Spotify does not provide an atomic compare-and-set with other native credential writers, so concurrent external changes remain possible.

An unconfirmed creation must not be repeated. Read the credential inventory, compare the returned IDs and explicitly store the intended active credential if recovery is needed. Failed storage does not trigger an unapproved native revocation. Disconnecting OAuth or deleting an Adport project does not revoke native CAPI credentials; revoke them explicitly when the external access should end. These tools send no conversion events. Direct CAPI event ingestion remains a separate capability.

## Wire contract and tests

Core contracts were reviewed against official Spotify Ads API v3 documentation on 2026-08-31. Measurement and credential contracts were refreshed on 2026-11-05 against the [official v3 OpenAPI](https://developer.spotify.com/reference/ads-api/v3/api.yaml), SHA-256 `1ea6ac0383f0662debfc8dd544b78b1e23ff4b1a79ead9a84e339f049c5c76ff`:

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

Wire tests use synthetic responses and verify outgoing methods, paths, envelopes, scope checks, units and failure handling. Local database tests additionally check encrypted storage, project isolation and API-role denial. Native endpoint checks are a separate verification step; passing fixtures does not prove a connected account has every platform permission. Spotify NO_DELIVERY_NO_BILLING test accounts cannot produce delivery metrics; empty reports are expected there. Cloud OAuth approval is separate from local module implementation.

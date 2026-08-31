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

The current analytics endpoint does **not** support pagination and returns at most 15,000 elements. Results at that ceiling are marked potentially truncated. Older ALL queries can be expanded to month boundaries by LinkedIn; Adport checks returned dates and refuses to label an expanded period as the requested range. Missing metrics stay absent. An empty analytics response can mean no activity **or** insufficient reporting access; account discovery alone does not prove reporting permission.

## Official contract sources

Reviewed 2026-08-31; requests pin `Linkedin-Version: 202608` and `X-Restli-Protocol-Version: 2.0.0`.

- [Account schema and cursor search](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-08)
- [Campaign schema, creation, budget updates and consent requirements](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-08)
- [Campaign groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-08)
- [Targeting criteria structure](https://learn.microsoft.com/en-us/linkedin/shared/references/v2/ads/targeting-criteria)
- [Reporting behavior](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-08) and [metric response schemas](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-08)
- [Rest.li URL encoding](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version)
- [Authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) and [programmatic refresh](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

Tests use synthetic fixtures shaped by these references and assert outgoing URLs, headers, bodies, response contracts and policy behavior. They are not live-account tests. No live LinkedIn API call or app approval has been verified yet. Cloud connection support and application setup remain separate work.

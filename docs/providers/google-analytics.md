# Google Analytics 4 and Search Console

Both connections live under **Analytics & tracking** and are excluded from connected ad-account limits. Each project selects the properties its users and agents may read. Credentials remain encrypted in the existing tenant-isolated cloud vault.

Use `analytics_goals` to list GA4 key events and `analytics_acquisition_report` to read sessions, conversions and purchase revenue by session source, medium and campaign. Both use the selected property. Dates use its reporting timezone. [Examples and migration from the earlier GA4 tools](website-analytics.md)

Search Console answers organic Google Search questions by date, query, page, country, device or search appearance. `gsc_search_analytics` returns clicks, impressions, CTR and average position, with Pacific Time dates. It returns top rows rather than an exhaustive query export. `gsc_sitemaps` reads submitted sitemap status; `gsc_inspect_url` reads index status for a URL inside a selected property.

Website analytics and Search Console reads request read-only Google scopes. There are no GA4 configuration changes, sitemap submissions or indexing requests. GA4 and Search Console do not replace Google Tag Manager's tracking configuration tools.

## Hosted OAuth setup

Enable Google Analytics Admin API, Google Analytics Data API and Google Search Console API in the application project. Configure a dedicated web OAuth client with **Use this client for an AI-powered agent** enabled for Adport’s agent workflows. Keep human-driven Google API workflows on a separate client, as described in [Google’s client isolation guidance](https://support.google.com/cloud/answer/15549257#agentic-client). Register these exact callbacks:

- `https://app.adport.dev/api/oauth/ga4/callback`
- `https://app.adport.dev/api/oauth/gsc/callback`

Set `GOOGLE_ANALYTICS_CLIENT_ID` and `GOOGLE_ANALYTICS_CLIENT_SECRET` together in the server environment. These can use an independent application without changing the Ads/GTM verification submission. If both are absent, self-hosted deployments can reuse their Google Ads application; an incomplete pair is rejected.

Only `https://www.googleapis.com/auth/analytics.readonly` and `https://www.googleapis.com/auth/webmasters.readonly` are requested, independently. State, PKCE, granular-consent checks and the existing one-time OAuth transaction flow apply. Disconnect removes the local grant; provider-wide revocation remains a manual Google account action because it can affect other services.

Search Console is available to every project using its non-sensitive read-only scope. Publish the Google OAuth application for external users before connecting customer properties.

Adport Cloud's `analytics.readonly` application is verified, and GA4 connections are available to all Cloud projects. Each connection still requires Google consent and selection of the properties Adport can read. This approval does not cover Google Ads, Tag Manager or additional Analytics scopes.

Self-hosters must keep `GA4_OAUTH_ENABLED=false` until their own application's required Google approval is complete, then set it to `true`. `ANALYTICS_TEST_ORGANIZATION_IDS` permits explicitly listed internal projects to use GA4 during verification; Adport's approval does not transfer to another application.

For local BYO setup, see [the analytics package](../../packages/analytics/README.md).

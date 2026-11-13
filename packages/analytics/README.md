# @adport/provider-analytics

Read-only Google Analytics 4 and Google Search Console integrations for Adport.
Tool schemas are defined once in `@adport/core` and shared by MCP and the CLI.

- GA4: property settings, available dimensions/metrics, historical reports and realtime activity.
- Search Console: organic search performance, property permissions, submitted sitemap status and URL index inspection.

There are no configuration, sitemap submission or indexing mutation tools. Native reporting POST requests are read-only queries. Reports preserve provider units, GA4 decimal strings, time zones, pagination and privacy/sampling notices.

## Self-hosted connections

Enable Google Analytics Data API and Google Analytics Admin API for GA4, or Google Search Console API for Search Console, in your own Google Cloud project. Create an OAuth Desktop client and configure its secret securely as `GA4_CLIENT_SECRET` or `GSC_CLIENT_SECRET`. Run `adport connect ga4` or `adport connect gsc` and enter the matching client ID. The consent flow requests only `analytics.readonly` or `webmasters.readonly`.

For noninteractive startup, configure complete `GA4_CLIENT_ID`, `GA4_CLIENT_SECRET`, `GA4_REFRESH_TOKEN` or `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` triplets. Never commit credentials. A complete stored connection takes precedence over environment credentials.

Use `accounts_list` with provider `ga4` or `gsc`, then the corresponding `ga4_*` / `gsc_*` tools. Cloud projects can access only properties explicitly selected by their owner. Analytics properties do not consume advertising account capacity.

GA4 metadata describes registered custom dimensions and metrics. Realtime reporting supports a smaller set of fields. Search Console returns top rows and may omit anonymized queries; CTR is a fraction and position is an average. URL inspection reads Google's indexed view and does not request reindexing.

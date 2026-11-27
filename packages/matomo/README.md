# @adport/provider-matomo

Read-only [Matomo](https://matomo.org/) analytics provider for Adport, for Matomo Cloud and self-hosted instances. Tool schemas are defined once in `@adport/core` and shared by MCP and the CLI.

- `matomo_site`: site URL, time zone, currency and ecommerce setting.
- `matomo_report_metadata`: reports available for a site (module, action, dimension, metrics).
- `matomo_report`: aggregated reports through `API.getProcessedReport` (visits, referrers, campaigns, goals, pages), with segments, per-period rows and offset pagination.
- `matomo_goals` and `matomo_segments`: goal and stored segment definitions.

There are no write tools. Visitor-level data (`Live`, `UserId`) is refused. Requests are `POST <base>/index.php` with `token_auth` in the form body, never in the URL.

## Connect

Create an auth token in Matomo under Administration → Personal → Security → Auth tokens, ideally for a dedicated user with view access only. Set `MATOMO_URL` (for example `https://example.matomo.cloud` or `https://analytics.example.com/matomo`) and `MATOMO_TOKEN_AUTH` in your environment, then run `adport connect matomo`. A stored connection takes precedence over the environment pair. See [the Matomo guide](https://github.com/ynnickw/adport/blob/main/docs/providers/matomo.md).

This package is part of [Adport](https://github.com/ynnickw/adport). Most users should install the [`adport` CLI](https://www.npmjs.com/package/adport). Requires Node.js 22.13 or newer.

Licensed under Apache-2.0.

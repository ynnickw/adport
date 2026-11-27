# Website analytics

Connect a brand’s GA4 property or Matomo site in its Adport project. Use `projects_list` and `accounts_list` to choose the project, provider and enabled account. The CLI, MCP and Cloud API expose the same two read-only tools for every website analytics source.

| Tool | What it returns |
| --- | --- |
| `analytics_goals` | Configured conversion goals with site-scoped IDs, names and counting rules when available. |
| `analytics_acquisition_report` | Sessions, conversion counts and revenue for each observed source, medium and campaign combination. Set `landing_page` to include the session entry page. |

```sh
adport tools run analytics_goals --input '{"provider":"matomo","account_id":"1"}'
adport tools run analytics_acquisition_report --input '{"provider":"matomo","account_id":"1","start_date":"2026-11-01","end_date":"2026-11-07","goal_ids":["4"],"landing_page":true}'
```

Replace the site and goal IDs with values from your project. For GA4, set `provider` to `ga4` and use the selected property ID. Dates are inclusive in the site’s reporting timezone. Pass `next_cursor` as `cursor` with the same inputs to continue. Goal selection changes conversion counts and returns `goal_counts` keyed by ID. Sessions and revenue still cover the entire acquisition group. Revenue is in major units of the returned currency. `null` identifies an unresolved dimension or unavailable metric. Zero is a reported count or amount.

To compare with spend, run the advertising `report` for the same project and dates. Match campaigns through a verified tagging convention or explicit mapping. Sum website outcomes to campaign level before joining spend when a campaign has several landing pages. Keep unmatched rows visible and check both reporting timezones and currencies. A website conversion and an ad platform’s attributed conversion can credit different campaigns.

GA4 uses session acquisition, key events and purchase revenue after refunds. Matomo uses its campaign archives and native conversion attribution. Ecommerce sites report order revenue. Other sites report revenue recorded on goal conversions. Each response identifies the basis and any provider limitations.

## Migration

Replace saved `ga4_report` acquisition requests with `analytics_acquisition_report` and use `analytics_goals` to select events. The earlier GA4 property, arbitrary-report, metadata and realtime tools have been removed. The proposed Matomo-specific tools are superseded by the shared pair. Use the provider’s own MCP for exploratory analysis, realtime activity and configuration. Search Console provides organic search data and Tag Manager manages tags through their existing tools.

## Implementing an adapter

1. Implement `AcquisitionAnalytics` and expose it as `AdProvider.acquisitionAnalytics`. Keep authentication, provider queries and native response parsing in the provider package. Return an empty provider-specific tool list. The registry registers the two tools once.
2. Add the source ID to `ANALYTICS_PROVIDERS`, wire its connection and enabled-site inventory into the local and hosted runtimes, and use existing project selection, vault and account-scoping helpers. Register the platform in the CLI, MCP and Cloud platform directories as needed.
3. Test exact upstream requests against the provider’s documented API. Include two sites with overlapping goal IDs, a nonconverting session, partial tags, empty dates, genuine zero revenue, disabled dimensions, pagination and landing pages. Verify that selecting only one provider or project prevents all reads against the other, including when both use the same numeric site ID.
4. Run both tools through a real site or test installation and reconcile sessions, selected goals and revenue with its native aggregates. Advertise an unsupported dimension or source limitation explicitly when the provider cannot produce the requested grouping.

A future PostHog adapter can use this same contract once a project has designated its conversion events and established a session acquisition and revenue definition. A data-quality system that only validates datasets does not satisfy the website analytics contract.

[GA4 connection guide](google-analytics.md) · [Matomo connection guide](matomo.md)

# Matomo

Read-only source for [Matomo](https://matomo.org/) web analytics, on Matomo Cloud
(`https://<organization>.matomo.cloud`) or a self-hosted instance, including one
served under a sub-path such as `https://analytics.example.com/matomo`. The local CLI, local MCP server and Adport Cloud share the same eight analytics tools.

Matomo answers acquisition, campaign, page, goal and ecommerce questions from its
aggregated reports. There are no write tools: Adport never changes sites, goals,
segments, users or tracking settings. Visitor-level data is refused: the `Live`
visitor log, `UserId` reports, and segments on `userId`, `visitorId`, `visitId`,
`visitIp` or `fingerprint`. `MultiSites` is refused too, since it reads every site
the token can view regardless of `account_id`. Discovery and reports also exclude
heatmaps, session recordings and A/B tests.

Tests use synthetic responses shaped after the
[Reporting API](https://developer.matomo.org/api-reference/reporting-api),
[report metadata](https://developer.matomo.org/api-reference/reporting-api-metadata) and
[segmentation](https://developer.matomo.org/api-reference/reporting-api-segmentation)
references (checked 2026-11-27). Read calls (period keys, unformatted metric values,
error messages) were checked against the public Matomo demo instance on 2026-11-27,
but not against a private instance with a real token.

## Create a token

In Matomo, open **Administration → Personal → Security → Auth tokens** and create a
token. A user with **view** access to the sites you want to report on is enough;
we recommend a dedicated view-only user so the token cannot change anything even
outside Adport. If Matomo offers it, restrict the token to POST requests: Adport
always sends it in the POST body.

## Connect in Adport Cloud

In **Analytics & tracking**, choose **Add source → Matomo** and enter the instance URL and a token with view access. Adport verifies the token, stores it in the encrypted project vault and asks you to choose sites. Enable the selected sites for assistants. Analytics sites do not consume advertising account slots.

Use a publicly reachable HTTPS domain for Matomo Cloud or a self-hosted installation. For a private-network installation, use the local CLI or stdio MCP on that network. Reconnecting to a different instance clears its predecessor’s site selections because each instance assigns its own site IDs. Disconnect removes the project’s credentials. Revoke the token in Matomo to invalidate it there.

The Standard, Reporting and Full profiles include the eight read tools when Matomo is selected. Use `capabilities_list` with provider `matomo` to check access.

## Connect locally

Provide both values securely in your shell environment:

- `MATOMO_URL`: the instance base URL, for example `https://example.matomo.cloud` or
  `https://analytics.example.com/matomo`. It must use `https` and contain no
  credentials, query or fragment. A trailing `/` or `/index.php` is removed.
- `MATOMO_TOKEN_AUTH`: the auth token.

Run `adport connect matomo`. The command lists the sites the token can view
(`SitesManager.getSitesWithAtLeastViewAccess`) and then stores the normalized URL
and token locally with mode 0600. Without stored credentials, the MCP server and
CLI also load the environment pair. If the stored or environment URL is unusable
(for example not `https`), Matomo is skipped and `adport doctor` shows it as not
connected, while the other providers still load; `adport connect matomo` reports the
error. `adport doctor` checks the connection;
`adport disconnect matomo` removes the local copy only, so delete the token in
Matomo to revoke it.

Every request is `POST <base>/index.php` with `module=API`, `format=JSON` and
`token_auth` in the form body. The token never appears in a URL. Redirects are
refused and requests time out after 30 seconds.

## Tools

| Tool | Matomo API | Purpose |
| --- | --- | --- |
| `accounts_list` (provider `matomo`) | `SitesManager.getSitesWithAtLeastViewAccess` | Sites as accounts, with currency and time zone |
| `matomo_site` | `SitesManager.getSiteFromId` | URL, time zone, currency, ecommerce and site search flags |
| `matomo_report_metadata` | `API.getReportMetadata` | Available reports: module, action, dimension, metrics, parameters |
| `matomo_report` | `API.getProcessedReport` | Any aggregated report, normalized into rows, totals and metric labels |
| `matomo_campaign_performance` | Report metadata and the installed campaign report | Visits and outcomes by tagged campaign, with the same dates, segments and pagination as `matomo_report` |
| `matomo_realtime_report` | `Live.getCounters` | Aggregate visits, visitors, actions and converted visits for the last 1–60 minutes |
| `matomo_segment_metadata` | `API.getSegmentsMetadata` | Available segment filter names, types and accepted values for the selected site |
| `matomo_goals` | `Goals.getGoals` | Goal definitions |
| `matomo_segments` | `SegmentEditor.getAll` | Stored aggregate segment definitions. Segments that identify a visitor and their names are omitted. |

Use `matomo_report` for site analytics. For tagged campaigns, use `matomo_campaign_performance`. It selects `MarketingCampaignsReporting.getName` when installed or `Referrers.getCampaigns` when the site advertises it. Visits and attributed conversions are Matomo measurements. Read spend and clicks from the ad platform. Examples of
`module`/`action` pairs: `VisitsSummary`/`get`, `Referrers`/`getReferrerType`,
`Referrers`/`getCampaigns`, `Goals`/`get`, `Actions`/`getPageUrls`, and
`MarketingCampaignsReporting`/`getName` when that plugin is installed.
`matomo_report_metadata` lists what the instance actually offers.

`matomo_report` takes `start_date` and `end_date`. With the default `period: "range"`
Matomo sums the dates (`period=range`, or `period=day` for a single date). With
`day`, `week`, `month` or `year` it returns rows per period. Each row has a `date`
dimension holding the ISO start date of its period (`YYYY-MM-DD`; weeks start on
Monday, months and years on their first day) and a `period_label` dimension with
Matomo's own label, which depends on the token user's language. Daily rows are
limited to 93 days.
Optional inputs: `segment`, `id_goal` (only with module `Goals`), `flat` (on by
default for `Actions` reports), `filter_sort_column`/`filter_sort_order`, `limit`
(1–1,000, default 100) and `offset`. The result includes `next_offset` and `truncated: true` only when
Matomo returns another row in at least one requested period. Reports with a single row and no dimension (such as `VisitsSummary`/`get`)
are never paged.

## Units, time zone and currency

- Dates use the site's time zone, returned in `date_range.timezone`.
- Metrics are requested unformatted (`format_metrics=0`), so they are plain numbers.
  `metric_types` marks money, percent and duration metrics when Matomo reports them.
- Money metrics are in the site currency (`currency`), in major units (`12.5` is 12.50).
- Percent metrics are fractions: `0.45` means 45%.
- Duration metrics (`duration_s`, such as `avg_time_on_site`) are in seconds.
- Custom ranges and segments may be archived on demand, which can be slow on large
  sites or unavailable if the instance disables browser-triggered archiving.

## Privacy and limits

- Only aggregated reports are read. The `Live`, `UserId` and `MultiSites` modules
  (compared case-insensitively) and segments naming `userId`, `visitorId`, `visitId`,
  `visitIp` or `fingerprint` (case-insensitively, also once URL-decoded) are refused
  before any report request. The realtime tool calls only `Live.getCounters` and returns aggregate counters.
- Matomo error messages are classified (token rejected, access denied, segment,
  unknown report) but never echoed, and the token is never logged or returned.
- A token tied to a user with broader rights still only reaches these read
  methods through Adport, but a view-only user remains the safer choice.
- Goal-specific nested metrics in rows are not flattened; request a goal report
  with `id_goal` instead.

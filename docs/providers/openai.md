# OpenAI Ads

Provider for the [OpenAI Ads API](https://developers.openai.com/ads), which manages
ads shown in ChatGPT. The local CLI, MCP and hosted Cloud runtime share the same
provider and tools. Tests use synthetic responses shaped after the official
OpenAPI 2.3.0 contract and guide examples. Live reads and campaign previews were
verified on 2026-11-18 against a real account; write application remains unverified.

## Connect in Cloud

Open **Ad platforms → OpenAI Ads → Connect**, enter an Advertiser API key, then
finish account selection. Cloud verifies the key before replacing an existing
connection, encrypts it in the tenant credential vault, and applies the same
account-access, plan, tool-catalog and write-policy checks as other platforms.
Only owners and admins can manage this connection. Disconnect removes the stored
key; revoke it separately in OpenAI Ads Manager. This requires the OpenAI
connection migration to be applied before deployment.

## Connect locally

Create an Advertiser API key in [Ads Manager settings](https://ads.openai.com/settings).
Each key is bound to exactly one ad account. Securely provide it as
`OPENAI_ADS_API_KEY` in your shell environment, then run `adport connect openai`.
The command reads the key's ad account (`GET /v1/ad_account`) before storing the
key locally with mode 0600. Without stored credentials, the MCP server and CLI
also load `OPENAI_ADS_API_KEY` from the environment. `adport disconnect openai`
removes the local copy only; revoke the key in Ads Manager.

Partner keys and the Ads OAuth flow (`OpenAI-Ad-Account` header) are not
supported yet.

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `openai_list_campaigns` | read | Every campaign, with status and budgets in micros |
| `openai_ad_groups` | read | Optional `campaign_id` filter |
| `openai_ads` | read | Optional `ad_group_id` filter; includes review status |
| `openai_create_campaign` | guarded create | Paused by default and forced paused by policy; at least one spend limit; optional bidding type, objective, schedule, countries or location IDs; conversion bidding requires one event setting; sends an `Idempotency-Key` |
| `openai_set_campaign_status` | guarded update | `active` or `paused` through the native activate/pause actions |
| `openai_set_ad_group_status` | guarded update | Same, for ad groups |
| `openai_set_ad_status` | guarded update | Same, for ads |
| `openai_set_budget` | guarded update | Daily or lifetime spend limit in integer micros (minimum 1,000,000); reads the current value for the policy delta and resends the other limit unchanged |

| `openai_conversion_sources` | read | Pixel and Conversions API sources with their `pixel_id` |
| `openai_conversion_event_settings` | read | Conversion goals: event type, window, sources and the campaigns using each |
| `openai_conversion_events` | read | Latest events received by one source (type, channel, event and receipt times), to check that tracking arrives; payloads are dropped |
| `openai_conversion_insights` | read | `POST /v1/conversions/insights`: goal conversions (click and view), attributed sales, optional per-event counts, per entity or account-wide |

`report` and `accounts_list` work across providers as usual. Every write goes
through the preview → pending operation → apply flow. Previews are local: the API
has no dry-run endpoint for these operations. Writes compare the API receipt with
every submitted field, including targeting and schedules, and fail with the resource
ID when they differ. Budget changes also verify the preserved spend limit.

## Reporting semantics

- `GET /v1/ad_account/insights` with `time_granularity=none` and one
  `date_range` (inclusive end, in the ad account time zone).
- Levels map to `aggregation_level`: account → `ad_account`, campaign, ad group, ad.
- `spend` and `order_created_attributed_sales` are major currency units in the
  account currency (not micros). `conversions` includes click-through plus
  view-through goal conversions with the API's default windows (30-day click,
  1-day view, ad-event time).
- `conversion_value` maps to `order_created_attributed_sales`. CTR, CPC, CPM, CPA
  and ROAS are derived locally from the returned totals and stay absent when their
  denominator is zero.
- Requests use canonical field names (`campaign.id`, `campaign.spend`); responses
  come back as flat keys (`campaign_id`, `spend`). Conversions and attributed sales
  are requested by their bare names, as in the official examples.
- Query arrays require bracket syntax: `fields[]=campaign.id` and
  `time_ranges[]=...`. Repeating plain `fields` keys returns HTTP 400. This was
  reproduced against the live API and is covered by wire-format assertions.
- `null` metrics mean unavailable and stay absent; they are never reported as zero.

## Contract sources

Reviewed 2026-11-18. The OpenAPI schema supports daily-only caps, objectives and
country codes, although the prose campaign guide shows a narrower lifetime-cap
and location-ID workflow. These supported inputs are retained pending live verification.

| Area | Source |
| --- | --- |
| Authentication, base URL, rate limits | [API overview](https://developers.openai.com/ads/api-overview) |
| Accounts | [Ad Account reference](https://developers.openai.com/ads/api-reference/ad-account) |
| Campaigns, ad groups, ads | [Campaigns](https://developers.openai.com/ads/api-reference/campaigns), [Ad groups](https://developers.openai.com/ads/api-reference/ad-groups), [Ads](https://developers.openai.com/ads/api-reference/ads) |
| Insights | [Insights reference](https://developers.openai.com/ads/api-reference/insights) |
| Full contract | [OpenAPI spec](https://developers.openai.com/ads/openapi.json) |

## Live verification and remaining coverage

Account discovery, campaign/ad-group/ad/source/event-setting lists, conversion
insights and reporting at all four entity levels passed against a real account.
`today` and `last_7_days` report ranges also passed. The CLI connection flow and
built MCP stdio account/campaign/report calls passed with the same credential.

The account was empty: event diagnostics, status and budget tools were checked
only for their native missing-resource rejection. No campaign, ad group, ad or
tracking source was created. Campaign creation was previewed through the policy
engine; no live ad or measurement write was applied. Populated metric
normalization and successful write receipts still need real-resource verification.

When a targeted spend limit was unset, its preview has no `fromMicros`, so only
the absolute caps apply (same as other providers).

## Not covered yet

Ad group and ad creation, uploads, custom audiences, pixel and event-setting
writes, product feeds, the Bulk API, and spend-limit windows.

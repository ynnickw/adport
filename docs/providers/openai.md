# OpenAI Ads

Provider for the [OpenAI Ads API](https://developers.openai.com/ads), which manages
ads shown in ChatGPT. The local CLI and MCP runtime include it; it is tested
against synthetic responses shaped after the official OpenAPI 2.3.0 contract and
guide examples. It has not yet been verified against a live ad account. The
hosted cloud runtime does not load it yet.

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
| `openai_create_campaign` | guarded create | Paused by default and forced paused by the `paused_creation` policy; at least one spend limit; optional bidding type, objective, schedule and country targeting; sends an `Idempotency-Key` |
| `openai_set_campaign_status` | guarded update | `active` or `paused` through the native activate/pause actions |
| `openai_set_ad_group_status` | guarded update | Same, for ad groups |
| `openai_set_ad_status` | guarded update | Same, for ads |
| `openai_set_budget` | guarded update | Daily or lifetime spend limit in integer micros (minimum 1,000,000); reads the current value for the policy delta and resends the other limit unchanged |

`report` and `accounts_list` work across providers as usual. Every write goes
through the preview → pending operation → apply flow. Previews are local: the API
has no dry-run endpoint for these operations. Writes compare the API receipt with
the requested values and fail with the resource ID when they differ.

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
- `null` metrics mean unavailable and stay absent; they are never reported as zero.

## Contract sources

Reviewed 2026-11-17.

| Area | Source |
| --- | --- |
| Authentication, base URL, rate limits | [API overview](https://developers.openai.com/ads/api-overview) |
| Accounts | [Ad Account reference](https://developers.openai.com/ads/api-reference/ad-account) |
| Campaigns, ad groups, ads | [Campaigns](https://developers.openai.com/ads/api-reference/campaigns), [Ad groups](https://developers.openai.com/ads/api-reference/ad-groups), [Ads](https://developers.openai.com/ads/api-reference/ads) |
| Insights | [Insights reference](https://developers.openai.com/ads/api-reference/insights) |
| Full contract | [OpenAPI spec](https://developers.openai.com/ads/openapi.json) |

## To verify against a live account

- Canonical field names on every aggregation level, including `ad_account`.
- Ranges that end today: the API rejects future bounds and normalizes `date_range`
  to the next local midnight.
- Budget-change policy: when the targeted spend limit was unset, the preview has
  no `fromMicros`, so only the absolute caps apply (same as other providers).

## Not covered yet

Ad group and ad creation, uploads, custom audiences, conversion pixels and
events, product feeds, the Bulk API, spend-limit windows, and the cloud runtime.

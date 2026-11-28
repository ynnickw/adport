# Gravity

Provider for the [Gravity advertiser API](https://docs.trygravity.com), which manages
ads shown inside AI assistants and chat apps. The CLI, MCP server and Adport Cloud
share one set of provider tools.

## Connect in Adport Cloud

In **Ad platforms → Gravity → Connect**, choose the permissions for the project. The dialog defaults to **Read, edit and change spend**. You can also choose **Read and edit campaigns** or **Read campaigns and reports**. Sign in as an advertiser owner or admin, approve the permissions in Gravity, then confirm the advertiser in Adport. Enabling it uses one advertising account slot.

Adport publishes its public OAuth client metadata at `/oauth/clients/gravity` on its HTTPS Cloud origin. Gravity supports public clients with PKCE. The exact callback is `/api/oauth/gravity/callback`. Adport stores and refreshes each project's grant in the encrypted vault and requests revocation on disconnect. A Cloud operator does not need a shared advertiser key or client secret. [Gravity sign-in and permission guide](https://docs.trygravity.com/advertisers/claude-chatgpt)

OAuth uses Gravity's advertiser MCP resource. Adport discovers the compatible advertiser operations and validates their results. Changes still use the project's preview and approval flow. If Gravity returns a separate approval plan or has no compatible operation, Adport reports this to the caller. The **Use an advertiser API key** option connects through Gravity's dashboard REST API. An administrator can rotate a key in the Gravity dashboard to revoke it.

## Connect locally

Copy the advertiser API key from the [Gravity dashboard](https://app.trygravity.com),
**Settings → Organization**. Only owners and admins can see it. The key has full
access to one advertiser account and has no scopes, so keep it out of shell history
and issues. Securely provide it as `GRAVITY_API_KEY` in your shell environment, then
run `adport connect gravity`. The command reads the key's advertiser (`GET /info`)
before storing the key locally with mode 0600. Without stored credentials, the MCP
server and CLI also load `GRAVITY_API_KEY` from the environment.
`adport disconnect gravity` removes the local copy only; rotate the key in the
Gravity dashboard to revoke it.

The account ID is the key's `advertiser_id`. The `/info` profile also returns the
login email; Adport never surfaces it.

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `gravity_list_campaigns` | read | Every campaign with status, delivery status, budgets in dollars and lifetime totals; optional `status` filter |
| `gravity_ad_groups` | read | Generative or manual ad groups with up to 100 ads each; optional `campaign_id` filter and `include_archived` |
| `gravity_conversions` | read | Recent conversions (event type, value in cents, source, click- or view-through), to check that pixel or server tracking arrives; follows the cursor up to `limit` (max 500) |
| `gravity_ads` | read | Ads within one selected ad group, including the native total and whether the group response is truncated when Gravity supplies that total |
| `gravity_get_ad` | read | Fetch one generated or manual ad, including creative content and review status |
| `gravity_pixels` | read | Sites with registered pixels, activation and installation check status |
| `gravity_conversion_stats` | read | Daily conversion counts and totals by event type over a date range or lookback |
| `gravity_billing` | read | Total spend, billed, unbilled and credits in dollars |
| `gravity_create_campaign` | guarded create | Draft by default; `active` is forced to paused by policy. Exactly one daily or total budget in micros (whole cents); a total budget needs `end_time`; a `conversions` objective needs `conversion_type`. Creates one generative ad group from a target `context` (optional negative context and brand name); optional schedule, countries, devices and English-only |
| `gravity_create_ad_group` | guarded create | Create a manual or generative group under an existing campaign. Generative groups need target context. Defaults to paused |
| `gravity_create_ad` | guarded create | Add a headline, copy, call to action and destination to a manual group. Defaults to paused |
| `gravity_create_pixel` | guarded create | Register a site's conversion pixel. Gravity checks installation in the background |
| `gravity_set_campaign_status` | guarded update | `active` or `paused`; reads the current status first. Gravity checks billing and the conversion event on activation and may send the campaign to review again |
| `gravity_set_ad_group_status` | guarded update | Same, for ad groups |
| `gravity_set_ad_status` | guarded update | Same, for manual ads only; generated ads are refused (pause their generative ad group instead) |
| `gravity_set_budget` | guarded update | Updates the campaign's existing daily or total budget in micros (whole cents); reads the current value for the policy delta and refuses budget-type changes |

`report` and `accounts_list` work across providers as usual. Every write goes
through the preview → pending operation → apply flow. Previews are local: the API
has no dry-run endpoint. Writes compare the API receipt with the submitted name,
status, objective and budget, and fail with the resource ID when they differ.

Campaign creation has no documented idempotency key. If the request times out
after Gravity accepted it, a retry can create a second campaign; check
`gravity_list_campaigns` before retrying.

## Reporting semantics

- Account and campaign levels use `GET /metrics` (one call per campaign, at most
  five in parallel); ad group uses `GET /ad-group-metrics` (paginated with
  `offset`); ad uses `GET /ad-unit-metrics`.
- Report days are cut in UTC: `tz=UTC` is sent explicitly and the account timezone
  is reported as UTC. `end_date` is inclusive.
- Spend and revenue are US dollars (major units, not micros). Gravity documents no
  other account currency, so the account currency is reported as USD.
- `conversion_value` maps to `total_revenue`. CTR, CPC, CPM, CPA and ROAS are
  derived locally from the returned totals and stay absent when their denominator
  is zero.
- `null` metrics mean unavailable and stay absent; they are never reported as zero.
- The `ad` level reads ad units (`ad-unit-metrics`), which return impressions,
  clicks and spend. Each row represents one campaign and ad unit, with reporting ID
  `campaign_id/ad_unit_id`. Rows sourced from campaign totals are labeled. For ad
  status changes, use the manual ad ID from `gravity_ad_groups`. Conversion and
  revenue metrics are available at campaign level.

## API behavior

- Base URL `https://platform.trygravity.com/advertiser-dashboard/`, header `X-API-Key`.
- About 100 requests per second per IP. HTTP 429 is not retried automatically;
  the error reports the `Retry-After` delay.
- The advertiser endpoint returns structured `error.code` values such as
  `auth_missing`. Older responses carry `detail`, sometimes as `{ code, message }`. HTTP 402 means billing
  is not set up or has failed.

## Contract sources

| Area | Source |
| --- | --- |
| Authentication and key rotation | [Advertiser API overview](https://docs.trygravity.com/api-reference/advertiser/overview) |
| Creating and updating campaigns | [Campaign API](https://docs.trygravity.com/api-reference/advertiser/campaigns) |
| Manual and generative groups, authored ads | [Ad group and ad API](https://docs.trygravity.com/api-reference/advertiser/ad-groups) |
| Metrics, conversions and billing | [Reporting API](https://docs.trygravity.com/api-reference/advertiser/reports) |
| Pixel registration and installation status | [Pixel API](https://docs.trygravity.com/api-reference/advertiser/pixels) |

## Verification

The public advertiser API returned HTTP 401 with code `auth_missing` without a
key. Authenticated reads and changes are covered by wire-contract tests using the
published API examples. Live delivery, spend and provider acceptance of writes
require an approved Gravity advertiser account.

Adport currently supports creative creation and status changes. Editing existing
copy or targeting, delivering server-side conversion events and archiving campaigns
remain available through Gravity's dashboard or API.

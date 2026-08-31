# Pinterest Ads — local connection

Register your own app at [Pinterest Developers](https://developers.pinterest.com/apps/). Trial access is intended for testing; obtain Standard access before onboarding external users. Adport does not bundle a shared client secret or bypass Pinterest review.

1. Obtain the app ID and secret after approval.
2. Register `http://localhost:53686/callback` as an exact redirect URI, without a secondary redirect.
3. Provide `PINTEREST_CLIENT_SECRET` securely through your terminal environment, then run `adport connect pinterest`. Do not paste secrets into issues, chat or command history.
4. Authorize `ads:read` and `ads:write`. Use `--no-browser` to open the printed authorization URL yourself.
5. The wizard verifies account discovery before replacing local credentials. Credentials live in `~/.config/adport/credentials.json` with mode 0600.

For noninteractive runtime assembly, provide the complete `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`, `PINTEREST_REFRESH_TOKEN` set. Complete stored credentials take precedence. Refresh-token rotation is saved for store-backed credentials; environment-only consumers must manage durable rotation themselves. Continuous refresh tokens expire after 60 days without renewal; access tokens last 30 days. Reauthorization may be necessary after prolonged inactivity.

## Supported surface

- Account discovery and campaign listing with bookmark pagination, including archived/draft campaigns.
- Shared normalized reports at account, campaign, ad-group and ad levels.
- Guarded campaign creation with campaign budget optimization (CBO), explicit paused creation and daily/lifetime budgets in account-currency micros. Lifetime budgets require an end time. APP_INSTALL/CTV and other restricted objectives still require Pinterest eligibility.
- Guarded campaign status and CBO budget updates, preserving the existing budget type. Flexible daily budgets and non-CBO campaign budget changes are rejected rather than misrepresented as ordinary daily caps.
- Every mutation uses Adport's existing preview, pending-token, exact-approval and audit flow. Pinterest does not offer server-side validation for these operations; previews are local.

This is not a complete creative-authoring or ad-group management surface. Campaign creation alone does not create Pins, ads, targeting or child ad groups. Cloud OAuth callbacks and approval are separate work.

## Contract and reporting decisions

Inspected against Pinterest's [official OpenAPI 5.28.0](https://github.com/pinterest/api-description/blob/main/v5/openapi.json) on 2026-08-31, plus [OAuth documentation](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/) and [redirect setup](https://developers.pinterest.com/docs/getting-started/connect-app/).

- Campaign POST/PATCH sends an array to `/ad_accounts/{id}/campaigns`. `CampaignBatchItem` responses contain `data` and optional `exceptions`; HTTP 200 alone does not prove success. Old `{campaign: ...}` response wrappers are not accepted.
- Budget fields are integer `daily_spend_cap` / `lifetime_spend_cap`. No cents conversion. Creation explicitly disables flexible daily budgets.
- Reporting sends inclusive UTC dates with `granularity=TOTAL`. Synchronous analytics supports a maximum 90-day range and a 90-day lookback; Pinterest rejects older dates. No silent date clamping.
- Entity filters are chunked at 250 IDs. Query arrays follow the current OpenAPI form/explode default; `columns` explicitly uses comma-separated encoding. No aggregate-across-entity rows are requested.
- `spend` = `SPEND_IN_MICRO_DOLLAR`, `impressions` = `PAID_IMPRESSION`, `clicks` = `OUTBOUND_CLICK_1`, `conversions` = `TOTAL_CHECKOUT`, `conversion_value` = `TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR`. Conversion semantics are checkouts, not every conversion event.
- Despite their names, MICRO_DOLLAR fields use the advertiser's currency. Divide by 1,000,000 for normalized spend/value. No FX conversion.
- Attribution is explicit: 30-day click, 1-day view, conversion reporting at time of ad action. Missing/null metrics remain absent; ratios are derived only from available dependencies.
- The published analytics schema enumerates entity IDs/date but leaves metric keys open. The adapter validates consumed metric values as finite nonnegative numbers (also accepts strictly numeric strings defensively). Tests use synthetic values conforming to these contracts; they are not live-account evidence.

No live Pinterest API calls or ad mutations have been verified yet. Approval and local credentials are still required for live read testing.

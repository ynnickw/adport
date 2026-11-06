# Pinterest fixed and average daily budgets

The configured amount and the delivery mode are separate decisions. Adport's
shared absolute and percentage limits check the native configured micro amount.
They are not a guarantee of actual spend on an individual day. Pinterest's
average-daily mode is therefore explicit in inputs, previews and receipts.

| Workflow | Tool |
| --- | --- |
| Read current mode, currency and context | `pinterest_campaign_budget_context` |
| Create a fixed, average or lifetime CBO campaign | `pinterest_create_campaign` |
| Set a confirmed fixed/average daily mode and optional amount | `pinterest_set_campaign_daily_budget` |
| Change an existing fixed daily or lifetime amount | `pinterest_set_budget` |

These definitions are shared by MCP, CLI and REST. Every mutation retains the
same preview/apply gate, policy caps, protected-account checks, paused creation
and append-only audit. No project policy or OAuth grant is changed.

## Read current configuration

Call `pinterest_campaign_budget_context` with `account_id` and `campaign_id`.
It verifies the native account and campaign IDs and returns account currency,
configured amount, CBO ownership, mode and `context_hash`. The hash binds current
configuration, account metadata and project scope. Tracking URLs stay out of the
public result. Native observations and creation/update timestamps are excluded
from configuration comparisons.

The result distinguishes fixed daily, average daily, lifetime, non-CBO ownership,
ambiguous caps and an unconfirmed daily mode. A missing native flexible flag is
not silently interpreted as fixed. Non-CBO campaigns use existing ad-group budget
tools. Lifetime campaigns retain their separate amount workflow.

## Create

`pinterest_create_campaign` still defaults to `daily_budget_mode: "FIXED"`.
To create an average-daily campaign, supply:

```json
{
  "budget_type": "DAILY",
  "daily_budget_mode": "AVERAGE",
  "budget_micros": 5000000,
  "acknowledge_variable_daily_spend": true
}
```

The normal account/name/objective/status inputs are also required or defaulted
by the existing creation schema. Native CBO and flexible flags are set explicitly.
The pause policy still coerces supported new campaigns to PAUSED and reports
the coercion. Lifetime plus average-daily mode is invalid. Native account currency
must be confirmed; no default currency, cents conversion or exposure multiplier
is inserted.

This selects a budget mode. It does not configure a full Performance+ campaign,
change bidding/targeting or create ad groups, ads or Pins. Other native objective,
program and campaign restrictions still apply.

## Update

Use `pinterest_set_campaign_daily_budget` with the current `expected_context_hash`
and explicit `daily_budget_mode`. Optional `budget_micros` changes the amount;
omission preserves the current amount while changing mode. An unchanged request
is rejected. The campaign must be editable, CBO, and have exactly one positive
daily cap with a confirmed fixed/average mode.

If either the current or requested mode is average daily, also provide
`acknowledge_variable_daily_spend: true` and
`acknowledge_averaging_reset: true`. Status, schedule, objective, bids, targeting,
CBO ownership and child configuration are not part of this mutation. The native
PATCH body contains only ID, daily cap and flexible flag. Readback verifies the
requested values and preservation of omitted campaign settings.

The generic `pinterest_set_budget` remains the amount-only fixed/lifetime path.
For average mode it directs the agent to context and the explicit daily tool,
so an assistant can complete the workflow without Ads Manager. Native eligibility
can still reject a mode change. There is no atomic conditional write, and an
uncertain or failed mutation is never automatically replayed. Known IDs and safe
native error codes are retained for reconciliation.

## Averaging and review

Pinterest averages flexible spend over a Sunday–Saturday period, shortened by
launch, edits, unpausing or an early end. Editing can reset the averaging period
without deducting previous spend. Same-day delivery can include old and new
allocations. Its published 125% figure is a target, not a guaranteed maximum.

Widget previews distinguish **Configured daily average** from **Fixed daily cap**,
show native currency, preserve status and pass exact reviewed arguments through
the same write tool. A configuration receipt does not certify a daily delivery
ceiling. The limits above constrain configured values; Adport does not install a
real-time spend monitor or silently change policy to accommodate average mode.

Contracts inspected 2026-11-06 against the [Pinterest-owned OpenAPI
5.28.0](https://github.com/pinterest/api-description/blob/51aca009f10a90283ccdf3956d509fc995ebac23/v5/openapi.json),
[campaign creation guide](https://developers.pinterest.com/docs/work-with-ads/create-campaigns-and-ad-groups/)
and [budget semantics](https://help.pinterest.com/en-gb/business/article/set-up-campaign-budgets).
Wire, policy and simulated host tests remain separate from native API and actual
Claude/ChatGPT verification.

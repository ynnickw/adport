# Reporting semantics

Adport normalizes provider reports into a shared row shape. Normalization makes one query surface possible; it does not make every provider's measurement methodology identical.

## Row identity and units

Every row includes `provider`, `accountId`, an entity (`level`, `id`, `name`, optional `status`), and requested metrics.

- `spend`, `conversion_value`, `cpc`, `cpm`, and `cpa` are decimal values in the ad account's currency. They are not micros and Adport does not apply exchange rates.
- `impressions`, `clicks`, and `conversions` are counts. Some providers return fractional attributed conversions; callers must not assume conversions are integers.
- `ctr` is a percentage (`clicks / impressions × 100`), not a 0–1 ratio.
- `roas` is a ratio (`conversion_value / spend`), so `1` means tracked value equals spend.
- Missing metrics remain absent. Adport does not turn an unavailable value into zero.

Never sum monetary values across accounts with different currencies. Group by provider, account, and currency first, or convert outside Adport using an explicitly sourced exchange rate and timestamp.

## Dates and time zones

Explicit ranges are ISO dates and inclusive at both ends. Presets resolve as follows:

- `today`: current UTC calendar date;
- `yesterday`: previous UTC calendar date;
- `last_7_days`: the seven completed UTC dates before today;
- `last_30_days`: the thirty completed UTC dates before today;
- `this_month`: first UTC date of the current month through today.

Providers may interpret report dates in an account time zone. Adport currently sends the resolved calendar dates to each provider and does not shift hourly data between zones. For decisions near midnight, record the provider account time zone and use an explicit range. Cross-provider daily comparisons can have boundary skew when accounts use different zones.

## Attribution and freshness

Conversions and conversion value retain each provider's configured attribution model, window, identity rules, and postback latency. A Meta conversion and a Google conversion can both be valid without representing the same causal event. Adport does not deduplicate cross-platform conversions or restate them under a common attribution model.

Recent dates can change as providers backfill modeled or delayed conversions. Record the query time and date range for any approval or exported analysis. Treat ROAS and CPA comparisons as directional unless account currency, conversion definitions, attribution windows, and data freshness are aligned.

## Safe comparison checklist

Before shifting budget based on a normalized report, confirm:

1. account currencies match or were explicitly converted;
2. the date range covers completed days in the relevant account time zones;
3. conversion actions and conversion-value definitions are comparable;
4. attribution windows and view-through treatment are understood;
5. low-volume rows have enough observations to support the decision;
6. the proposed change still passes Adport's preview, budget caps, protected-account rules, and approval gate.

# Google campaign targeting

`google_campaign_targeting` reads an existing campaign's location criteria,
language criteria, device criteria and weekly schedule, plus retained radius and
location-group references. It returns `snapshot_hash`, native configuration and
compact records with **Load more**. Criteria IDs remain strings. Continuations
are bound to the same account, campaign, configuration and page size; a changed
snapshot requires refreshing the first page.

The complete internal read is bounded to 20,000 relevant criteria. Large
campaigns can contain many unrelated negatives and other criterion families;
those are outside this read's filter and are not reset by these edits. The hash
covers returned references and selected campaign/budget/timezone fields, not
performance, external feed contents or every targeting dimension.

## Prepare changes through an agent

Read the current snapshot, then preview `google_update_targeting` with
`campaign_id`, `expected_snapshot_hash` and
`acknowledge_delivery_effects: true`, plus the requested changes:

| Field | Behavior |
| --- | --- |
| `locations.include` | `add_ids` and `remove_ids` change positive location IDs. |
| `locations.exclude` | `add_ids` and `remove_ids` change excluded location IDs. |
| `languages` | Adds/removes eligible language IDs; Search supports legacy removal only. |
| `ad_schedules` | Replaces weekly intervals; `[]` removes their time restrictions. |
| `device_bid_modifiers` | Edits selected existing device multipliers; `0` opts out. |
| `positive_geo_target_type` | Edits location inclusion intent through its exact native leaf mask. |
| `negative_geo_target_type` | Edits location exclusion intent where native campaign eligibility permits. |

Location and language deltas preserve every unmentioned criterion. Added
constants are independently resolved and checked for current targetability.
Use `google_gaql` with `geo_target_constant` or `language_constant` to discover
IDs. Adding an existing selection, removing a missing one, duplicated IDs and
contradictory inclusion/exclusion of the same ID are rejected. Radius/group
references are retained; removing all positive location IDs does not remove
those other geographic criteria. Without other positive geography, an empty
included-location list can broaden reach to all countries and territories,
subject to exclusions and native campaign requirements.

Every schedule interval requires `day`, `start_hour`, `start_minute`, `end_hour`
and `end_minute`. Minutes are 0, 15, 30 or 45; `24:00` is a valid end. End times
are exclusive, and intervals use the account timezone. Split overnight windows
across days. Overlap and more than six intervals per day are rejected. Matching
existing intervals preserve their modifier unless supplied; changed immutable
intervals are removed and recreated. An unspecified new modifier is left to the
native default, rather than reported as a verified value.

Bid multipliers are ratios from 0.1 to 10. A device can also use 0 for exclusion.
An absent native multiplier remains **Not reported**; Adport does not substitute
1. Device criteria are read from the existing campaign and cannot be created or
removed here. Native eligibility and the bidding strategy determine whether a
modifier affects bids. A multiplier is not a currency amount, budget change or
monetary bid ceiling. Native float32 readback is compared at its actual precision.

## Current native restrictions

Search campaigns no longer accept new or updated manual language criteria.
Existing campaign-level language criteria can still be queried and removed,
but do not control serving. Search matching uses creative/landing-page language
and user preferences. `google_create_campaign` rejects `language_ids` for Search
instead of implying a new restriction. Performance Max language criteria apply
to non-Search channels. Other campaign types retain native eligibility checks.
See Google's [current criteria guide](https://developers.google.com/google-ads/api/docs/targeting/criteria#language_targeting_criteria).

Native validation also rejected direct status edits for the tested location,
schedule and device criteria. This tool therefore exposes no criterion status
setter. Use supported add/remove operations or device opt-out. Campaign and ad
status tools remain separate. Search location inclusion supports PRESENCE or
PRESENCE_OR_INTEREST; exclusion supports PRESENCE. Other native enum/campaign
combinations still require server validation, rather than being assumed valid
because a protobuf enum contains the value.

## Approval and verification

The same definitions serve CLI, REST and MCP. All mutations go through the normal
policy preview, expiring pending operation, identical-arguments apply and audit
log. Previews call Google's native `validateOnly`; apply rechecks the snapshot
and validates again before executing. The operation uses one atomic
`googleAds:mutate` request with `partialFailure=false`. Only requested criteria
and geographic intent masks are submitted; parent campaign/ad statuses and
monetary budgets are preserved. New criteria are enabled within the existing
campaign, so edits can affect an enabled campaign immediately.

Apply verifies receipt identities and independently reads the complete selected
configuration again, checking new/removed/updated criteria and preservation of
other returned criteria, campaign status and budgets. Unconfirmed outcomes
retain known resource IDs and must be reconciled before another mutation. No
write is retried automatically. Google provides no atomic compare-and-set, so a
configuration hash cannot lock concurrent account changes.

The MCP record viewer pages without replacing existing cards or scroll. Agents
prepare changes; the shared Google review shows only changed targeting fields,
account timezone, parent status and meaningful native restrictions before
approval. No separate organization/distribution interface is added.

Wire contracts were checked against the official
[v25 campaign criterion proto](https://github.com/googleapis/googleapis/blob/eecf37ae63995d1860eba342cd2922a70ec679f8/google/ads/googleads/v25/resources/campaign_criterion.proto)
and [schedule definitions](https://github.com/googleapis/googleapis/blob/eecf37ae63995d1860eba342cd2922a70ec679f8/google/ads/googleads/v25/common/criteria.proto),
plus the current targeting guide. Live checks on 2026-11-06 used account-scoped
reads and validation-only requests for locations/exclusions, schedules and bid
multipliers. They made no Google apply and confirmed unchanged configuration.
Positive apply/readback and actual Claude/ChatGPT host execution remain separate
from mocked wire tests and synthetic SDK/DOM bridges.

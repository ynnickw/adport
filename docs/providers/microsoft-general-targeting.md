# Microsoft campaign and ad-group targeting

`microsoft_targeting_context` and `microsoft_update_targeting` expose one scoped
workflow through CLI, REST and MCP. Use a target such as:

```json
{
  "type": "AdGroup",
  "campaign_id": "CAMPAIGN_ID",
  "ad_group_id": "AD_GROUP_ID"
}
```

Campaign targets use `type: "Campaign"` with `campaign_id`. IDs are decimal
strings. Read the context first, then supply its `context_hash` as
`expected_context_hash`, the same `target`,
`acknowledge_delivery_effects: true` and one `change`. Every mutation uses the
shared preview/apply approval and audit engine. Microsoft has no targeting dry
run, so previews read native configuration and prepare a local review.

## Read owned and inherited configuration

The reader verifies the native account, campaign and optional ad-group
hierarchy. It reads seven concrete families: Age, Gender, Device, DayTime,
Location, LocationIntent and Radius. Both owned and campaign criteria are shown
for ad groups; `effective: false` marks an overridden or inapplicable row.
Inherited criterion IDs cannot be edited through an ad-group target.
`effective` identifies the selected source, not proof of native eligibility or
delivery. A retained location intent without geographic criteria is inapplicable.

`criterion_types` filters displayed rows. `page_size` defaults to 50 and accepts
up to 200. **Load more** appends records without replacing mounted cards or
scroll position. Continuations bind the account, target, filters, page size and
configuration hash. Changed configuration requires refreshing the first page.
Internal complete reads are bounded to 20,000 criteria per entity; other native
families are outside this snapshot and are not submitted by these mutations.

Ad-group criteria override campaign criteria of the same type. They do not
intersect with campaign criteria to provide a narrower layer automatically.
Locations, negative locations and radii form **one geographic family**: adding
any ad-group geographic criterion stops inheriting all campaign geographic
criteria. For example, adding only an ad-group country exclusion can remove an
inherited positive country restriction. The review shows before/after positive
location, exclusion and radius counts, the source and representative IDs.
Location intent alone does not change which entity supplies geographic targets;
an ad-group intent is ignored while campaign geography is inherited.

Schedule and device overrides work independently. Removing the last own
schedule, or the complete own device set, can restore campaign inheritance.
Without applicable criteria at either level, that family imposes no additional
restriction, subject to native campaign eligibility and defaults.

## Changes prepared by agents

| `change.action` | Required fields and behavior |
| --- | --- |
| `add` | `targets`: 1–1,000 typed criteria. Unmentioned criteria remain. Duplicate selections are rejected. |
| `set_bid` | `criterion_id`, `criterion_type`, `bid_adjustment_percent`. Edits one owned biddable criterion, preserving its definition. |
| `remove` | `criterion_ids`: 1–1,000 exact owned IDs. Location intent cannot be removed; devices must be removed as a complete set. |
| `set_location_intent` | Exact `criterion_id` and `intent_option`: `PeopleIn` or `PeopleInOrSearchingForOrViewingPages`. No bid is submitted. |
| `set_schedule_clock` | `use_searcher_time_zone`: changes only that entity's native schedule-clock flag. |

Targets use the existing shared Microsoft target schemas. Location targets can
be included or excluded; other negative demographic/device formats are not
authored here. Use `microsoft_geo_locations_file` for current geographical IDs.
Radius distance is a native integer in Miles or Kilometers; it is not a currency
amount. Audience targeting and its TargetAndBid/BidOnly setting remain separate
tools. Specialized Performance Max device exclusions, Video/CTV devices,
profiles, placements and topics are distinct native workflows.

Native target criteria are Active and have no independent pause. Under default
`paused_creation`, additions require a paused campaign or a paused ad group.
This tool never pauses or activates a parent silently. Edits and removals on an
enabled hierarchy can affect delivery immediately, so the review includes
observed parent status and before/after effective targeting.

## Device percentages and schedules

Despite its native name, `BidMultiplier.Multiplier` carries percentage points:
`20` means +20%, and `-20` means −20%. It is neither the ratio `1.2` nor currency
micros. Supported edits use whole integers: −90 through 900 for ordinary
biddable types, and −100 through 900 for devices. A device adjustment of −100%
excludes that device. At least one of Computers, Smartphones and Tablets must
remain included; creation and deletion use the complete three-device set.
Automated bidding can treat adjustments as signals rather than direct overrides.
Missing native percentages remain **Not reported**, never assumed to be zero.

DayTime intervals use quarter-hour minute values: Zero, Fifteen, Thirty or
FortyFive. End time must follow start within one day, with `24:00` as a valid
end. Split overnight windows across days. A resulting schedule cannot overlap,
exceed seven intervals per day or exceed 49 per week. Intervals are immutable:
changing hours requires separate reviewed removal and addition. Pause delivery
before a replacement that could temporarily broaden reach.

The schedule clock follows the native `AdScheduleUseSearcherTimeZone` flag of
the entity whose schedule is effective. True uses each searcher's local time;
false uses the account's current native timezone. The deprecated campaign
`TimeZone` field is not used to infer this. Missing clock/timezone evidence is
explicit, and edits that require an unverified clock are rejected. The review
shows the clock before and after an override or inheritance change. Changing an
ad-group clock while its schedule is inherited does not change the campaign's
effective clock.

## Apply and verify

Each approval submits **one native mutation request** with the documented
Targets selector and the appropriate Campaign/AdGroup fields. There is no
invented atomic multi-request schedule replacement. Native partial errors and
uncertain outcomes retain acknowledged or affected IDs and are never retried
automatically. Exact input arguments, policy and expiry remain bound to the
pending operation.

Apply independently reads the full selected context again. It verifies created,
updated and removed criteria, unmentioned returned criteria, inherited campaign
criteria for ad-group edits, parent statuses/settings/budgets and account
timezone configuration. A hash cannot lock concurrent native changes; an
unconfirmed readback requires reconciliation before another mutation.

The older campaign-specific targeting tools remain compatible and reuse the
same target definitions and wire builder. For new work, use the scoped context
and update pair to review inheritance and detect configuration drift. Local
generic target/clock writes cannot bypass these typed checks. Hosted connections
need the specialist tools enabled through Full tool access.

Contracts were checked against Microsoft's
[targeting guide](https://learn.microsoft.com/en-us/advertising/guides/show-ads-target-audience?view=bingads-13),
[bid adjustment definition](https://learn.microsoft.com/en-us/advertising/campaign-management-service/bidmultiplier?view=bingads-13),
[device rules](https://learn.microsoft.com/en-us/advertising/campaign-management-service/devicecriterion?view=bingads-13),
[schedule definition](https://learn.microsoft.com/en-us/advertising/campaign-management-service/daytimecriterion?view=bingads-13)
and the pinned official
[REST SDK](https://github.com/BingAds/BingAds-Python-SDK/blob/4b6fb31cedf75f7067bbd4aafb0a07c9a2f7e22a/openapi_client/api/campaign_management_service_api.py).
Native QA uses only a disposable paused ad group under a paused QA campaign,
with no ads or conversion events. Synthetic SDK/DOM tests remain separate from
actual Claude/ChatGPT host execution and do not prove every campaign variant.

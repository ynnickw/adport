# Google campaign conversion goals

These named tools choose which conversions a Google Ads campaign optimizes for. They use the shared CLI/MCP registry and policy engine. Every mutation first sends a native `validateOnly: true` request and returns an approval token. An identical apply call re-reads native state, checks the snapshot hashes, validates again and then executes. Campaign statuses and budgets are never changed.

Google Ads has three goal layers:

- **Account default goals** (`goal_config_level: CUSTOMER`): the campaign follows the account's category/origin goals, such as *Purchase · Website*.
- **Campaign-specific standard goals** (`goal_config_level: CAMPAIGN`): the campaign has its own `biddable` flag for each category/origin pair. It stops following later account-level goal changes.
- **Custom goals**: a named list of specific conversion actions. A campaign that uses one optimizes for those actions, whether or not each action is `primary_for_goal`, and also for any standard goal it still marks as biddable.

## Read

`google_custom_conversion_goals` lists custom goals, with each conversion action's ID and name. With cross-account conversion tracking, Google's [campaign goals guide](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals) says the list includes goals from the conversion customer. Adport reads only through the selected account. If a campaign uses a goal that this account does not return, the campaign shows only that goal's `resource_name`, and the goal cannot be assigned from here; check it in Google Ads or select the account that owns it. Removed goals are excluded unless `include_removed` is true. Continue `next_cursor` as `after_goal_id`. Each goal includes `snapshot_hash`; supply it as `expected_goal_hash` when assigning the goal.

With optional `campaign_ids` (up to 50), the same call also returns `campaigns`: for each one, the goal level, the custom goal with its actions, the standard goals with `biddable`, and a plain-language `summary`. It then also returns a top-level `snapshot_hash` that covers the whole campaign selection, regardless of order. Supply it as `expected_snapshot_hash` with the same `campaign_ids`. Campaigns are returned on every page of a paginated goal list.

## Create a custom goal

`google_create_custom_conversion_goal` takes a `name` and 1–100 enabled `conversion_action_ids`. Google requires custom goals to be created in the account that owns conversion tracking. If tracking is managed by another account, the tool refuses and names that account; select it explicitly to create the goal. Creating a goal attaches it to no campaign. Renaming, editing or removing a custom goal is done in Google Ads.

## Set a campaign's goal

`google_set_campaign_conversion_goal` changes 1–50 campaigns in one atomic request: every listed change applies, or none does. It takes:

- `goal: { type: "CUSTOM_GOAL", custom_conversion_goal_id, expected_goal_hash }` to use a custom goal, or `goal: { type: "ACCOUNT_DEFAULT" }` to return to account goals (native mask `goal_config_level`).
- `standard_goals`, optional: `"DISABLE_ALL"` sets every standard goal of each campaign to not biddable, or a list of `{ category, origin, biddable }` toggles. Every listed pair must exist on every selected campaign. Standard goals cannot be combined with `ACCOUNT_DEFAULT`, because toggling them makes the goals campaign-level again.

Adport always sets the campaign level explicitly, in the same atomic request. For a campaign that is not yet at `CAMPAIGN` level, a custom goal is sent as `goalConfigLevel: CAMPAIGN` together with `customConversionGoal` (mask `goal_config_level,custom_conversion_goal`). A change to standard goals alone sends a `goal_config_level` update to `CAMPAIGN` before the `biddable` updates. A campaign already at `CAMPAIGN` level that moves to another custom goal gets only the `custom_conversion_goal` mask. Google's guide says the backend would switch the level on its own; the explicit update means the result does not depend on that. Both fields are writable on [`ConversionGoalCampaignConfig`](https://developers.google.com/google-ads/api/reference/rpc/v25/ConversionGoalCampaignConfig).

To make campaigns optimize **only** for a custom goal's actions, pass the custom goal together with `standard_goals: "DISABLE_ALL"`. Each campaign needs at least one biddable standard goal or a custom goal. Without the disable option, campaigns keep bidding on their biddable standard goals as well, and the preview warns about this campaign by campaign.

The preview shows a before/after line per campaign in plain words, for example *Account default goals (Purchase · Website)* → *Campaign-specific goals: custom goal "Leads" optimizing for "Demo request"; no standard goals used for bidding*. Campaigns that already match are shown as *No change* and send no operation. After apply, Adport reads the campaigns back and confirms the goal level, custom goal and toggled flags. If Google rejects the request with error details, that native error is returned as is: nothing was applied. A transport failure, a server error or a receipt or readback that does not match is reported as an unconfirmed outcome, with any acknowledged resource names, and is never retried automatically.

Google validates whether each campaign type supports the requested goal. For example, App campaigns use their own selective optimization setting.

The contracts follow the v25 [custom conversion goal](https://github.com/googleapis/googleapis/blob/97f6460c3558c1435d7fd001a9251f8df058ae2f/google/ads/googleads/v25/resources/custom_conversion_goal.proto), [conversion goal campaign config](https://github.com/googleapis/googleapis/blob/97f6460c3558c1435d7fd001a9251f8df058ae2f/google/ads/googleads/v25/resources/conversion_goal_campaign_config.proto) and [campaign conversion goal](https://github.com/googleapis/googleapis/blob/97f6460c3558c1435d7fd001a9251f8df058ae2f/google/ads/googleads/v25/resources/campaign_conversion_goal.proto) resources. They also follow Google's [campaign goals guide](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals). Writes use `googleAds:mutate`, because the per-service goal mutate requests have no `partial_failure` field.

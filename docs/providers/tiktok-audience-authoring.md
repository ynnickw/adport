# TikTok rule and lookalike audiences

These typed tools share the MCP, CLI and REST registry. Every mutation requires
the normal preview, exact arguments and `pending_operation_id`. They do not
activate ads, attach targeting, share an audience or change grants.

| Tool | Native v1.3 operation |
| --- | --- |
| `tiktok_identities` | `GET /identity/get/` |
| `tiktok_audience_sources` | Advertiser/identity source reads below |
| `tiktok_rule_audience_context` | Fresh source reads and local context hash |
| `tiktok_create_rule_audience` | `POST /dmp/custom_audience/rule/create/` |
| `tiktok_create_lookalike_audience` | `POST /dmp/custom_audience/lookalike/create/` |
| `tiktok_refresh_lookalike_audiences` | `POST /dmp/custom_audience/lookalike/update/` |

## Select rule sources through the agent

Call `tiktok_audience_sources` with `account_id`, `source_type`, optional
`source_ids`, `page_size` (up to 20) and its opaque `next_cursor` to load more.
The cursor binds the exact selection, advertiser and identity. Native unpaged
inventories and live-video pages are sliced with a snapshot check. Paginated
responses retain native completeness; missing pagination cannot prove absence.
Widgets append cards and preserve scroll through both supported host bridges.

| Source type | Native read | Selected event source |
| --- | --- | --- |
| `APP` | `app/list` | `app_id`, distinct from `app_platform_id` |
| `BUSINESS_ACCOUNT` | `user/info` plus advertiser authorization | v1.3 `core_user_id` |
| `ENGAGEMENT` | `adgroup/get` | Advertiser's ad group ID |
| `ENGAGEMENT_ORGANIC_VIDEO` | `identity/info`, `identity/video/get` | Public organic video ID |
| `ENGAGEMENT_LIVE_VIDEO` | `identity/info`, `identity/live/get` | Live video ID |
| `LEAD_GENERATION` | Advertiser authorization | All available advertiser form events |
| `OFFLINE` | `offline/get` | Offline event set ID |
| `PIXEL` | `pixel/list` | Pixel ID |
| `TIKTOK_SHOP` | `store/list` | TikTok Shop ID; native BC references retained |

The token-level `user/info` read is preceded by an exact advertiser authorization
check. Its obsolete numeric `id` example is not substituted for `core_user_id`.
App partner tokens, tracking links, user email and other private metadata are
excluded. Discovery grants no new account, identity or Business Center access.

Video selection requires an exact `TT_USER` or `BC_AUTH_TT` identity. The latter
also requires `identity_authorized_bc_id`. `tiktok_identities` preserves native
identity/BC references and availability with `page`, `page_size` (up to 100),
`next_page`, `identity_list` and widget records. A native BC query may return
other linked identities. Exact source use independently checks `identity/info`.
Organic discovery is limited to TikTok's 500 most recent organic posts and is
not an inventory of every historical post.

## Create rule audiences

1. Discover source IDs. Specify `audience_type` and `rule_spec` with an
   `inclusion_rule_set` and optional `exclusion_rule_set`.
2. Call `tiktok_rule_audience_context` with the exact selection. Retain its
   `context_hash` as `expected_context_hash`.
3. Preview `tiktok_create_rule_audience` with that selection, a
   `custom_audience_name` and explicit `is_auto_refresh`. Review the source
   selection, inclusion/exclusion rules and refresh behavior, then apply.

Rule sets use native OR semantics, up to 20 clauses each, and one exact
`EVENT`/`EQ` action filter per clause. Event names are passed unchanged because
published enum and example aliases differ. Native eligibility remains
authoritative. Organic/live selections accept up to 10 distinct videos; other
types accept up to 100 distinct sources. Video and non-follow Business Account
events support only 7, 14 or 30 lookback days. Other documented lookbacks are
60, 90 and 180 days. `retention_in_days` is a separate optional 1–365-day
audience expiry setting.

Lead-generation rules forbid source IDs. Engagement rules may omit them.
Either case requires `acknowledge_all_event_sources: true`, because the rule
includes current and future sources available to the advertiser. All other
types require explicit source IDs. Positive access to every selected ID must
be established within the native visible window and Adport's 100-page bound.
Missing or ineligible sources stop the write. The context is checked again
before apply; it binds source metadata, not immutable event history or users.
Audience enhancement is explicitly disabled.

URL and parameter filters remain unsupported: the official SDK nests them
inside an action filter, while a published prose example uses conflicting
nesting. Strict schemas reject these arguments. [Audience sharing](tiktok-audience-sharing.md) has a separate guarded workflow. Advertiser
to Business Center migration and automated-rule authoring are separate gaps.

## Create and refresh lookalikes

Read a seed with `tiktok_get_custom_audience`, then pass its `snapshot_hash` as
`expected_source_snapshot_hash`. The seed must have proven creator or shared
recipient access, be available, non-expiring, not itself a lookalike, and report
at least 100 matched users. Apply rechecks these conditions.

`lookalike_spec` requires `source_audience_id`, explicit `include_source`,
`mobile_os`, `placements`, ISO country `location_ids` and `audience_size`.
Adport uses current v1.3 fields; deprecated `system` and `is_contain_source`
aliases are rejected.

Refresh accepts 1–100 distinct owned, available lookalikes with each current
`expected_snapshot_hash` and `acknowledge_shared_effects: true`. It checks the
whole batch before one native request, then independently reads every target.
Refresh may affect existing ad groups and shared recipients using an audience.
Native calls are not an atomic batch or conditional write and are never
automatically replayed after uncertainty.

## Interpret the receipt

Creation independently checks owned ID, name and documented native type when
available. TikTok's get table omits an OFFLINE type mapping; that response
reports `type_mapping_verified: false` and the native type without inventing one.
Only a recognizable, matching modern native rule/specification echo receives
`VERIFIED_NATIVE_ECHO`. Legacy, missing or unknown representations remain
`UNCONFIRMED_NATIVE_REPRESENTATION`; recognized contradictions fail with the
known created ID retained for reconciliation.

Successful requests return `ACCEPTED_FOR_PROCESSING`, `processed: false` and
`membership_verified: false`. Widgets show **Processing pending**. Metadata
readback is not proof of matched members, full rule semantics or final
availability. Newly reported native processing errors prevent certification.
Re-read the known ID; do not blindly create a replacement. Native processing
can take up to 48 hours.

Contract, policy and synthetic MCP SDK/widget tests cover these flows. Positive
native TikTok creation/refresh and actual Claude/ChatGPT host checks remain
pending; simulated bridges do not establish host compatibility.

Contracts inspected 2026-11-06: official [rule creation](https://business-api.tiktok.com/portal/docs?id=1739940509849601),
[lookalike creation](https://business-api.tiktok.com/portal/docs?id=1739940511844353),
[refresh](https://business-api.tiktok.com/portal/docs?id=1758616888158209),
[identities](https://business-api.tiktok.com/portal/docs?id=1740218420781057),
[identity info](https://business-api.tiktok.com/portal/docs?id=1740218453385217),
[organic posts](https://business-api.tiktok.com/portal/docs?id=1740218475032577),
[live videos](https://business-api.tiktok.com/portal/docs?id=1785238052792321),
[apps](https://business-api.tiktok.com/portal/docs?id=1740859313270786),
[offline sets](https://business-api.tiktok.com/portal/docs?id=1765596808589313),
[stores](https://business-api.tiktok.com/portal/docs?id=1752267762718722),
[user info](https://business-api.tiktok.com/portal/docs?id=1739665513181185),
[ad groups](https://business-api.tiktok.com/portal/docs?id=1739314558673922)
and the [official SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3).

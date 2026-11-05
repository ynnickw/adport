# TikTok automated rules

Existing rule configuration and execution history are available through the same
typed definitions in MCP, CLI and REST:

| Tool | Native v1.3 endpoint |
| --- | --- |
| `tiktok_automated_rules` | `GET /optimizer/rule/list/` |
| `tiktok_get_automated_rules` | `GET /optimizer/rule/get/` |
| `tiktok_automated_rule_results` | `GET /optimizer/rule/result/list/` |
| `tiktok_automated_rule_result_details` | `GET /optimizer/rule/result/get/` |

Use the selected advertiser's `account_id`. Rule and execution IDs stay strings,
including IDs beyond JavaScript's safe integer range. Provider errors remain
errors; a denied read does not become an empty inventory.

Lists expose native `page_info`, explicit completeness and `next_page` when
verified. The compact records widget appends with **Load more**, retaining the
account, filters, timezone and language. Adport limits pages and explicit-ID
requests to 100. The rule-ID lookup has no documented continuation parameter;
unreturned IDs do not prove absence. Execution details likewise carry no native
completeness marker. The full native configuration remains available alongside
the compact records.

History filters use UTC datetime pairs formatted `YYYY-MM-DD HH:MM:SS`. The
published history-filter enum spells lifetime budget `LIFERIME_BUDGET`; Adport
preserves that documented value. This spelling has not been confirmed against a
live advertiser. Configuration filters support status, rule ID/name and object
dimension; history additionally supports action and time.

## Native creation restriction

TikTok's current [Create rules documentation](https://business-api.tiktok.com/portal/docs?id=1738767670852610)
limits creation to direct advertisers and explicitly excludes SaaS platforms
managing multiple advertisers. Notifications go to the developer's registered
email address. Adport Cloud therefore does not expose automated-rule creation.

The API's scheduled budget/bid actions also require accounting for future
executions, selected entities and native monetary bounds. Generic local
`tiktok_api_create`, `tiktok_api_update` and `tiktok_api_delete` dispatchers reject
`optimizer/rule/*` mutations because their immediate-write budget checks cannot
enforce those scheduled effects. A future direct-advertiser write integration
needs a verified native workflow through the shared policy engine. No rule
status or deletion endpoint is invented.

These tools inspect existing rules; they do not run actions or send
notifications. Automated-rule writes, catalog management and positive live
verification remain separate work. See [campaign and creative setup](../tiktok-campaign-setup.md)
for the existing advertising workflow.

Contracts were checked on 2026-11-05 against the live documentation and TikTok's
[official SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3/yml_files).
Provider fixtures verify outgoing requests and documented response shapes;
fixtures and widget tests do not establish live advertiser or host success.

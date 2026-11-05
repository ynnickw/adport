# TikTok Ads

## Automated rules

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
notifications. Automated-rule writes, full catalog authoring and positive live
verification remain separate work. See [campaign and creative setup](../tiktok-campaign-setup.md)
for the existing advertising workflow.

Contracts were checked on 2026-11-05 against the live documentation and TikTok's
[official SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3/yml_files).
Provider fixtures verify outgoing requests and documented response shapes;
fixtures and widget tests do not establish live advertiser or host success.

## Project-scoped catalog access

TikTok catalogs are Business Center resources. An enabled advertiser account
does not establish access to all catalogs reachable by its OAuth token. Adport
requires a separate grant for the exact project, advertiser, Business Center and
catalog. There is no default Business Center wildcard.

A project owner or admin can open **Accounts → TikTok catalog access**, choose
the advertiser and enter a Business Center/catalog ID. **Review access** reads
that exact native catalog before preparing a read or read/write grant.
**Confirm access** applies the same arguments and pending-operation token. New
grants require an enabled, connected advertiser; revocation remains available
for imported advertisers after disablement or disconnection and makes no native
TikTok request. Access changes also pass through the shared policy engine and
audit log, including protected-account checks.

The owner endpoint accepts only signed-in dashboard sessions, validates the
request origin and project, and requires `connections:manage`. MCP tokens and
API keys cannot grant themselves more catalog access, including credentials
held by an owner. The permission runtime registers only the catalog access
controls, so it cannot call native mutation tools. A Reader-plan owner may
configure project access; native writes still require write entitlement, scope
and a writable catalog grant.

Hosted grants live in a private table with RLS and no `anon`/`authenticated`
privileges. Account and grant locks plus revision checks prevent stale approvals
from overwriting concurrent changes. Removing an imported advertiser cascades
its grants. Disabled or disconnected accounts are denied before any native
catalog access, even if their grant remains stored.

Local CLI/stdio uses private files under `ADPORT_HOME/catalog-access/tiktok`
(`~/.config/adport` by default). `tiktok_catalog_access_snapshot` and the guarded
`tiktok_set_catalog_access` are available to that local owner. Files are scoped
and hashed, published atomically with a per-resource lock, and retain revocation
revisions. Symlinks and transplanted scope records are rejected. Those two
administrative tools are omitted from hosted MCP and public REST catalogs.

## Catalog inspection and rename

| Tool | Backing operation |
| --- | --- |
| `tiktok_catalog_access` | Read the selected project/account's explicit grants |
| `tiktok_get_catalog` | `GET /open_api/v1.3/catalog/get/` with exact `bc_id` and `catalog_id` |
| `tiktok_update_catalog` | `POST /open_api/v1.3/catalog/update/` followed by independent exact-ID readback |

`tiktok_get_catalog` never enumerates a whole Business Center. It verifies a
single native result and its `bc_info.bc_id`, preserves native configuration,
and returns a `configuration_hash`. Compact widget records show the catalog
name, native eligibility, type, Business Center and currency; full data stays in
Details. Native ad eligibility does not establish that the catalog currently
has all products or settings needed to serve ads.

Rename requires read/write access, the exact current configuration hash and
`acknowledge_shared_effects: true`. It sends the native `name` field, preserves
other configuration and verifies a separate readback. The same Business Center
catalog may be reused by other ads or accounts. The operation changes no ad
status, budget or native user permission. Unconfirmed responses retain the
known catalog ID for reconciliation and never trigger automatic replay.

Current configuration hashes exclude timestamps and volatile eligibility
diagnostics. Native v1.3 IDs stay strings; requests use fixed endpoints,
mandatory trailing slashes, redirect rejection and a 30-second timeout. Provider
permission/error envelopes remain errors and do not become empty inventories.
Sensitive provider error bodies are excluded from the new catalog workflows.

Creation/deletion, feeds, products, product sets, catalog videos, event-source
bindings and migration from advertiser-owned catalogs remain separate work.
Read/rename and permission controls are contract, policy, SDK/widget and
disposable-Postgres tested; positive native provider and Claude/ChatGPT host
verification remain pending.

Contracts inspected 2026-11-05: [Get catalogs](https://business-api.tiktok.com/portal/docs?id=1740315452868610),
[Update catalog](https://business-api.tiktok.com/portal/docs?id=1740306544966657)
and the [official SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3).

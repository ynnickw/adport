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
| `tiktok_catalog_feeds` | `GET /open_api/v1.3/catalog/feed/get/`, optionally filtered by exact `feed_id` |
| `tiktok_catalog_feed_log` | `GET /open_api/v1.3/catalog/feed/log/` for the latest 10 processing operations |
| `tiktok_create_catalog_feed` | `POST /open_api/v1.3/catalog/feed/create/` with catalog hash and independent feed readback |
| `tiktok_update_catalog_feed` | `POST /open_api/v1.3/catalog/feed/update/` with mode and optional source/schedule replacement |
| `tiktok_set_catalog_feed_schedule_status` | `POST /open_api/v1.3/catalog/feed/switch/` with an opposite `ON`/`OFF` state |
| `tiktok_delete_catalog_feed` | `POST /open_api/v1.3/catalog/feed/delete/` followed by complete feed-list absence verification |
| `tiktok_update_catalog` | `POST /open_api/v1.3/catalog/update/` followed by independent exact-ID readback |
| `tiktok_product_sets` | `GET /open_api/v1.3/catalog/set/get/`, optionally filtered by exact `product_set_id` |
| `tiktok_product_set_products` | `GET /open_api/v1.3/catalog/set/product/get/` with exact parent IDs and native pages |
| `tiktok_rename_product_set` | `POST /open_api/v1.3/catalog/set/update/` with `product_set_name` and independent set readback |
| `tiktok_create_product_set` | `POST /open_api/v1.3/catalog/set/create/` with native conditions, followed by exact created-ID readback |
| `tiktok_update_product_set_conditions` | `POST /open_api/v1.3/catalog/set/update/` replacing conditions while preserving the name |
| `tiktok_delete_product_sets` | `POST /open_api/v1.3/catalog/set/delete/` for 1–10 snapshot-verified sets, followed by independent absence verification |

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

Product-set reads and renaming use the same explicit catalog grants. Set reads
return a `configuration_hash` bound to the advertiser, Business Center, catalog,
set name and filter conditions. Renaming requires that hash and
`acknowledge_shared_effects: true`; filter conditions are preserved, product
counts do not invalidate the snapshot, and an uncertain result retains the set
ID for reconciliation without replaying the write.

The native product-set list endpoint is unpaged. Adport bounds it to 5,000 sets
and offers local `cursor` / `page_size` navigation, with at most 100 sets per
page. Changing the selection or set configuration invalidates the cursor;
refresh the first page. `return_product_count` defaults to `false` because
TikTok warns that counts can time out on large sets. This is local pagination,
not a claim that the native endpoint provides server-side paging.

Products within a verified set use native `page` / `page_size` navigation, with
at most 100 products per request. Widgets can load more while retaining existing
cards. Missing or inconsistent pagination is reported as unknown completeness,
not as a complete inventory. Large string IDs remain exact; unsafe numeric IDs
are rejected rather than rounded. The SDK/widget checks use synthetic native
responses and do not prove live provider or Claude/ChatGPT host success.

Condition-based product-set creation requires the selected catalog's `configuration_hash` as
`expected_catalog_hash`, a name, conditions, and `acknowledge_shared_effects:
true`. Catalog access and configuration are rechecked before creating the set.
A successful native receipt is followed by an independent exact-ID read that
must confirm the name and filter definition. An uncertain response is never
automatically replayed; a known created ID is retained for reconciliation.

Conditions contain exactly one nonempty `and` or `or` group. Scalar operators
(`EQUAL`, `NOT_EQUAL`, `GT`, `LT`, `GTE`, `LTE`) require one value; list operators
(`CONTAIN`, `I_CONTAIN`, `EXCLUDE`, `I_EXCLUDE`) require a list. Substring/prefix
operators accept strings or lists of strings. Numeric values retain their
native units; use strings for integers beyond JavaScript's safe range. Adport
bounds the combined value count to 1,024, each text value to 2,048 characters,
and field names to 128 characters with optional dotted paths such as
`address.city`. TikTok validates catalog-specific fields, values and eligibility
on apply; the preview is local, not native validation.
Native filter definitions also reject unsafe numeric values before hashing;
oversized or deeply nested definitions fail the bounded inspection instead of
producing an approval hash from rounded or incompletely inspected data.

Filter replacement requires the current set's `configuration_hash` and shared
effects acknowledgement. Its preview shows the old and new product selection
and explains that existing ads using this set may select different products.
The existing name is preserved and independently verified. This operation has
a destructive hint because it replaces the full filter definition; name-only
renaming retains a non-destructive write hint.

Deletion takes `sets: [{ product_set_id, expected_configuration_hash }]`, with
1–10 unique entries, plus shared effects acknowledgement. The preview names
every selected set. All snapshots must still match before the native batch
request. Adport requires an exact ID receipt and a complete catalog-set read
confirming absence. The existing 5,000-set read bound applies to this readback;
an oversized, partial or inconsistent response leaves the result unconfirmed.
Partial outcomes retain all selected IDs, do not restore anything automatically
and never trigger a replay. This permanently removes shared set definitions;
existing ads may reference them.

The shared records/review widget presents readable filter criteria and the
same project/account/Business Center/catalog selection as the agent's approved
arguments. SDK and DOM checks use synthetic responses; native provider and
actual Claude/ChatGPT host execution remain unverified.

Feed reads use the same exact advertiser/Business Center/catalog grant. The
native list endpoint is unpaged; Adport bounds it to 5,000 feeds and provides
snapshot-bound local `cursor` navigation with up to 100 feeds per page. Feed
configuration hashes include known source/schedule settings and status, while
excluding volatile product counts and next-run timestamps. Source origins and
fingerprints are visible; source paths, query values, authentication values and
unknown native extensions stay hidden. Native reads cannot confirm stored
passwords, so these hashes cannot detect password-only changes made elsewhere.
Widget cards show status, feed type, frequency, mode and source origin; full
safe metadata remains in Details instead of repeating IDs and hashes on cards.

Feed creation requires `expected_catalog_hash`; other feed mutations require
`expected_configuration_hash`. All require shared-effects acknowledgement.
Creation, updates and schedule changes also require
`acknowledge_automatic_processing: true`: scheduled sources can start native
product processing, and `OVERWRITE` can remove products missing from the source.
Creating without a schedule must read back as `OFF` without a source URI.
`COUNTRY_FEED` requires a verified multi-country catalog; TikTok checks the
additional existing-product eligibility on apply.

Create modes are `INCREMENTAL` and `OVERWRITE`; updates also support native
`SUPPLEMENT`. Optional `schedule_param` accepts a complete source/schedule:
HTTP(S), FTP or SFTP URI; optional username/password; `interval_type`,
`interval_count`, IANA `timezone`, hour and minute; and an explicit
`day_of_month` for monthly runs. Intervals follow TikTok's 1–23 hourly, 1–30
daily and 1–12 monthly bounds. Adport defaults count to 1 and hour/minute to 0
and sends those values explicitly. Feed names are bounded to 256 characters.
URI user information, fragments and unsupported protocols are rejected; supply
authentication in its separate fields. When replacing a schedule, explicitly
supply any required authentication because native credential values cannot be
read back for preservation. Saved configuration is not proof that source
authentication or product ingestion succeeded.

Source-bearing arguments are marked private in the shared definition. Their
widget preview shows origin/fingerprint, schedule and effects; it does not echo
the source or credentials into widget approval arguments. The agent applies
the identical private arguments with the pending token. Source-free changes,
including schedule switches and deletion, retain normal widget approvals.
Schedule switches require a known opposite state. Enabling requires a configured
URI, interval and time zone; disabling does not undo earlier imports. Mutations
check current scope and snapshots, then independently verify saved settings or
deletion absence. Uncertain outcomes retain known feed IDs and never replay.

The processing log is a window of the latest 10 operations, not full history.
It reports native status, counts and timestamps; `SUCCESS` does not establish
catalog ad eligibility. SDK/widget tests use synthetic responses and do not
prove real provider or Claude/ChatGPT host success.

### CSV product sets

`tiktok_upload_product_set` creates an E-commerce product set from the official
single-column `sku_id` CSV template. Upload the document to Adport through an
agent, the widget or the dashboard, then provide its `media_id` and SHA-256.
Local CLI/stdio can use `file_path` instead. A writable catalog grant, fresh
catalog configuration hash, unique name of at most 28 characters and explicit
shared-effects acknowledgement are required. Adport accepts 1–5,000 nonempty,
distinct SKU rows and preserves text IDs, leading zeros and exact file bytes.

Preview validates the complete file and sends no mutation. Apply rechecks scope,
catalog, unique name and bytes, then sends native multipart `file` with the MD5
`file_signature` of those exact bytes. The receipt and independent scoped read
confirm the new set ID/name. They do not prove full SKU membership or ingestion.
Unknown outcomes retain known IDs and must be reconciled before another upload.
No ad is activated; the shared policy, audit and central-library distribution
tracking apply. Native provider and Claude/ChatGPT host verification remain pending.

### Product browsing and file imports

`tiktok_catalog_products` browses compact product summaries and image/video
previews in one explicitly granted catalog. Filter by native `product_ids`, or
by `sku_ids` for E-commerce catalogs. IDs remain strings, including leading-zero
SKUs and native IDs beyond JavaScript's safe-integer range. Each page is limited
to 100 items; TikTok permits access to only the first 10,000 matching results.
Narrow larger catalogs with ID filters. Missing or contradictory native paging
keeps completeness unknown; no next page is fabricated beyond the access cap.
Descriptions are clipped at 300 characters with an explicit truncation flag.
This is a compact browsing view, not full editable product configuration.
Previews require HTTPS URLs without embedded credentials. The shared widget
allows the two native media origins shown in TikTok's current video-info
contract: `p16-sign-sg.tiktokcdn.com` and `v16-tiktokcdn-com.akamaized.net`.
Arbitrary merchant origins and legacy HTTP/relative media paths are not
silently trusted or upgraded; a returned URL alone does not prove host playback.

`tiktok_import_catalog_file` consumes a ready `text/csv` project file for a
one-time import into an existing data or country feed. Upload through an agent,
the widget, dashboard or cloud media CLI, then provide `media_id`, SHA-256,
Business Center/catalog/feed IDs, and fresh hashes from `tiktok_get_catalog` and
`tiktok_catalog_feeds`. The hosted private media resolver supplies the temporary
download capability; agents do not supply arbitrary URLs or server file paths.
Local stdio without that private staging capability cannot submit this import.

The tool verifies complete CSV structure, distinct nonempty headers, at least
one product row, and the library's 50 MiB/100,000-total-row bounds. TikTok checks
catalog-specific columns, feed ownership and product eligibility asynchronously;
a locally valid CSV is not proof of a valid provider template. Use the official
[catalog feed templates and import contract](https://business-api.tiktok.com/portal/docs?id=1740496787164161).
INCREMENTAL adds or updates matching products while preserving omitted products.
OVERWRITE can remove feed products absent from the file and requires a separate
acknowledgement. Both modes can affect existing ads using those products.
The one-time mode does not change the feed's saved mode; scheduling is managed
separately. Read fresh feed state before changing automation.

Preview verifies source bytes and snapshots without minting a provider URL or
submitting a native mutation. Apply rechecks them, issues the private source
capability and submits native `catalog/product/file`. The returned `feed_log_id`
is independently read back against the selected catalog/feed. Adport rejects a
reported processing mode that differs from the approved mode. Unmapped native
numeric modes remain available in the log but cannot verify an approved import;
their codes are never guessed. A confirmed submission
reports `ACCEPTED_FOR_PROCESSING` with `processed: false`, plus the next status tool/arguments.
It does not claim completed ingestion. Temporary URLs, provider error bodies,
and native diagnostic download capabilities stay out of results and audit logs.

`tiktok_catalog_product_log` reads that exact job. WAITING/PROCESSING are pending;
SUCCESS/FAILED are terminal, with native add/update/delete/error/warning counts
when reported. Missing counts remain unavailable. SUCCESS can still contain
item errors and does not establish ad eligibility. Diagnostic field/count groups
are capped at 50 per severity; free-form messages and product samples are omitted.
An initial failed job, item errors or unconfirmed readback retains the known job
ID for reconciliation. No import is automatically replayed. Source distribution
history records acceptance separately from processing. If a queued provider job
cannot fetch its temporary source before expiry, inspect its final status and
review a new import rather than treating acceptance as success.

These flows have contract, policy and synthetic dual-bridge widget tests.
Positive native TikTok imports and actual Claude/ChatGPT host checks remain pending.

See [JSON catalog products](tiktok-json-products.md) for schema discovery across
all ten catalog types, snapshot-bound field updates/removal, asynchronous jobs
and checksum-bound reuse of central Adport media.

See [catalog videos](tiktok-catalog-videos.md) for CSV uploads, SKU verification,
async status, native previews and guarded removal.

See [catalog event sources](tiktok-catalog-event-sources.md) for advertiser
app/Pixel discovery, context snapshots, binding and unbinding with preservation
readback.

See [catalog creation and deletion](tiktok-catalog-lifecycle.md) for owner
delegation, immutable creation, exact new-resource adoption and permanent
whole-catalog deletion.

Migration from advertiser-owned catalogs remains separate work.
Read/rename and permission controls are contract, policy, SDK/widget and
disposable-Postgres tested; positive native provider and Claude/ChatGPT host
verification remain pending.

Contracts inspected 2026-11-05: [Get catalogs](https://business-api.tiktok.com/portal/docs?id=1740315452868610),
[Update catalog](https://business-api.tiktok.com/portal/docs?id=1740306544966657),
[Get product sets](https://business-api.tiktok.com/portal/docs?id=1740570556295169),
[Get products in a set](https://business-api.tiktok.com/portal/docs?id=1740571478441986),
[Update product set](https://business-api.tiktok.com/portal/docs?id=1740572974725122),
[Create product set](https://business-api.tiktok.com/portal/docs?id=1740572891104257),
[Create product set from CSV](https://business-api.tiktok.com/portal/docs?id=1846770644217858),
[Official SKU CSV template](https://bytedance.sg.larkoffice.com/sheets/GlkOsKz7RhRhfLtN0gblmYcjgjd),
[Delete product sets](https://business-api.tiktok.com/portal/docs?id=1740573143966722),
[Product set operators and fields](https://business-api.tiktok.com/portal/docs?id=1740673108747265),
[Get feeds](https://business-api.tiktok.com/portal/docs?id=1740665183073281),
[Get catalog products](https://business-api.tiktok.com/portal/docs?id=1740564136678402),
[Import catalog CSV](https://business-api.tiktok.com/portal/docs?id=1740496787164161),
[Get product import status](https://business-api.tiktok.com/portal/docs?id=1740570027173889),
[Get video information](https://business-api.tiktok.com/portal/docs?id=1740050161973250),
[Create feed](https://business-api.tiktok.com/portal/docs?id=1740665161957377),
[Update feed](https://business-api.tiktok.com/portal/docs?id=1740665197662210),
[Delete feed](https://business-api.tiktok.com/portal/docs?id=1740665210863617),
[Feed log](https://business-api.tiktok.com/portal/docs?id=1740665225631810),
and [Feed schedule status](https://business-api.tiktok.com/portal/docs?id=1750349624999937)
and the [official SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3).

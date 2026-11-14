# Reddit catalog products, sets and import diagnostics

These tools share the MCP, CLI and REST registry and the normal project/account
authorization. Start with the exact Business/catalog grants described in
[Reddit Business catalogs](reddit-catalogs.md). An advertiser connection alone
does not authorize Business assets. Each child read/write independently checks
the native catalog's Business identity; global child endpoints also verify the
child's catalog relationship.

| Tool | Native v3 operation |
| --- | --- |
| `reddit_catalog_products` | `GET /product_catalogs/{catalog_id}/products` |
| `reddit_catalog_product_sets` | `GET /product_catalogs/{catalog_id}/product_sets` |
| `reddit_get_catalog_product_set` | `GET /product_sets/{product_set_id}` |
| `reddit_catalog_product_set_products` | `GET /product_sets/{product_set_id}/products` |
| `reddit_create_catalog_product_set` | `POST /product_catalogs/{catalog_id}/product_sets` |
| `reddit_update_catalog_product_set` | `PATCH /product_sets/{product_set_id}` |
| `reddit_delete_catalog_product_set` | `DELETE /product_sets/{product_set_id}` |
| `reddit_catalog_imports` | `GET /product_catalogs/{catalog_id}/catalog_imports` |
| `reddit_catalog_import_issues` | `GET /catalog_imports/{import_id}/issues` |
| `reddit_catalog_import_report` | `GET /catalog_imports/{import_id}/report` |
| `reddit_catalog_product_context` | Exhausted selected-SKU `GET /product_catalogs/{catalog_id}/products` |
| `reddit_create_catalog_products` | `POST /product_catalogs/{catalog_id}/products/batch_upsert` |
| `reddit_update_catalog_products` | `POST /product_catalogs/{catalog_id}/products/batch_upsert` |
| `reddit_delete_catalog_products` | `POST /product_catalogs/{catalog_id}/products/batch_delete` |

## Browse products and sets

Paged tools accept `project_id`, `account_id`, `business_id`, `catalog_id`,
`page_size` (default 20, maximum 1,000) and a returned `cursor`. Set product reads
also need `product_set_id`. The native `next_url` is returned as `next_cursor`;
follow it through the same tool, preserving the selection. Foreign origins or
resource paths, non-advancing cursors, duplicate IDs and contradictory native
parent relationships are rejected. Each page rechecks access. `complete` refers
to native pagination exhaustion for that selection, not a frozen inventory.

Product views support selected `ids`, `approval_decision` and `search`; set
product views additionally support `issue_code`. Opaque product SKUs retain
commas, Unicode and slashes, up to Reddit's 128-character limit. The `ids`
parameter is repeated for each SKU, as the current OpenAPI requires. Product
views show the reported title, description, price, brand, availability, approval and issues; absent
fields remain unavailable. They do not claim to expose every product attribute.

Widgets embed native Reddit-hosted product preview images and display landing
links. Arbitrary merchant image hosts are not added to the shared widget CSP.
Read data retains safe native image links, but a missing/blocked preview is not
proof that a product has no image. Load more appends cards without rebuilding
existing nodes or discarding scroll. This is covered by both synthetic host
bridges, separately from actual Claude/ChatGPT execution.

Set lists retain raw native filters and configuration hashes in `product_sets`;
their visible records use readable filter descriptions. Native counts are
snapshots and do not affect configuration hashes. Missing counts are not zero.

## Create, edit and delete sets

1. Read `reddit_get_catalog` and retain its `configuration_hash`.
2. Preview `reddit_create_catalog_product_set` with exact scope, `name`,
   `filter`, `expected_catalog_configuration_hash` and
   `acknowledge_shared_effects: true`.
3. Review and apply identical arguments with the returned
   `pending_operation_id`.

The filter is one JSON string following Reddit's documented grammar, for example
`{"and":[{"brand":{"eq":"Acme"}},{"price":{"lt":"20.00"}}]}`.
It is serialized once in the native `{ "data": { ... } }` body. Adport validates
documented fields/operators and bounds the filter to 64 KiB, 500 rule nodes and
eight nesting levels. It never evaluates filter code. Reviews show readable
conditions; the exact JSON remains in the operation details and bound arguments.

For edits, read `reddit_get_catalog_product_set`, then preview
`reddit_update_catalog_product_set` with `expected_configuration_hash`, the
selected `name` and/or replacement `filter`, and shared-effects acknowledgement.
Only supplied fields are sent. Omitted configuration is preserved and checked
through an independent exact readback. Hashes bind account/Business/catalog/set
configuration; project permission is a separate required check. JSON object-key
order and whitespace are ignored, while rule/value and array order are retained.

For permanent deletion, use the current hash, exact `confirm_name`,
`acknowledge_shared_effects: true` and `acknowledge_remove_set: true`. Native
DELETE 204 is followed by an independent exact GET 404. A permission error is
not absence. The set definition is deleted; dependent ads and matching products
are not enumerated or frozen. No restore/global usage guarantee is claimed.

These are shared catalog changes. They can affect set membership and existing
ads using the set. They submit no ads, spend or conversion events. Native
receipt/readback failures preserve known resource IDs and are never replayed
automatically. Reconcile current state before another mutation.

## Imports and reports

`reddit_catalog_imports` supports repeated `feed_ids` and comma-separated native
`statuses`. Counts remain native snapshots. Issues and reports use global import
IDs, so Adport first establishes positive membership in the selected catalog's
native import history. This preflight is bounded to ten pages of up to 1,000
rows each; failure to find the selected ID within that bound refuses the global
request rather than treating it as an empty/clean result.

`reddit_catalog_import_issues` pages native severity/code/field/line/product
diagnostics and redacts credential-like text. Every returned issue must belong
to the selected import. `reddit_catalog_import_report` returns an unexpired
HTTPS native download URL only after membership proof. Adport does not fetch
that host or forward Reddit credentials. Native 204 is reported as unavailable,
which is not evidence of a clean import.

## Manual product management

Agents can create, edit and delete catalog products through the same MCP, CLI
and REST tools. Read `reddit_catalog_product_context` with exact external
`product_ids` first. It verifies the granted Business/catalog and exhausts
targeted native pagination before reporting each SKU present or absent. Retain
its `selection_hash`. This is a selection of at most 100 SKUs, separate from
the paged creative gallery; it is not a global inventory or usage snapshot.

Preview a named mutation with `expected_selection_hash` and
`acknowledge_shared_effects: true`, review the exact products, then apply the
identical arguments with `pending_operation_id`. Creation requires every SKU
absent and complete title, description, price, landing URL, image URL and
availability. Prices retain the native string including currency, such as
`19.99 EUR`; no currency conversion is inferred. Optional fields cover all 45
documented writable attributes, including custom labels/numbers, variants,
additional images, platform links, sale prices and expiration.

Updates require existing SKUs. Supply an `id` and the selected fields in each
`products` entry. Adport merges them with all currently known writable fields
and sends that complete configuration, excluding Reddit-owned metadata. Unknown
native fields refuse an update rather than silently dropping configuration.
Null can clear a nullable optional attribute; required authoring fields must
remain complete. Native strings and safe integers are bounded, URLs require
HTTP(S) without embedded credentials, and batches are capped at 100 products
and 1 MB of serialized UTF-8 data.

Deletion additionally requires `acknowledge_permanent_deletion: true` and
`product_ids`. These are external merchant SKUs, **not** `reddit.id` UUIDs.
Opaque commas, Unicode and slashes are preserved. Native deletion receipts
distinguish `DELETED` from `NOT_FOUND`; the latter is not claimed as a deletion
by this request. Every mutation rechecks the snapshot immediately before its
one native POST and independently verifies complete known configuration or
exhausted absence afterward. Missing optional values and null are equivalent
for comparison; missing required copy/price/URLs are not accepted.

Reddit has no conditional batch-write or atomicity guarantee. Another writer
can race preflight, including turning native creation into an update. Such a
contradictory receipt is not certified as a successful creation. Scheduled
feeds can overwrite edits or recreate deleted products. The preview explains
these effects on shared sets/ads. Partial or malformed receipts, native errors
and failed readbacks retain selected SKUs and safely identified native statuses;
ID-less invalid entries are not assigned to input rows by response position.
No batch or failed item is replayed automatically. Re-read each selected SKU
before preparing another operation.

## Verification and remaining scope

[Feed management](reddit-catalog-feeds.md) uses these same catalog grants.
The v3 OpenAPI refreshed on 2026-11-06 includes title and description in both
batch-upsert input and native Product output, resolving the earlier contract
discrepancy. Manual product authoring uses that refreshed contract.

Wire, policy, scope, pagination and synthetic SDK/widget checks cover these
tools. Positive native catalog-content writes and actual Claude/ChatGPT host
execution remain unverified. These tools do not activate ads or ingest events.

Contracts refreshed 2026-11-06 from the official
[v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json),
[product catalog guide](https://ads-api.reddit.com/docs/v3/guides/programs/product-catalogs),
[filter grammar](https://ads-api.reddit.com/docs/v3/guides/programs/product-catalogs/filter-products)
and [catalog requirements](https://business.reddithelp.com/articles/Knowledge/catalog-requirements).

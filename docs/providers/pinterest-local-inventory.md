# Pinterest local stores and inventory

Agents can manage physical stores and their per-store inventory in an explicit
advertiser-owned RETAIL catalog. The tools share the MCP, CLI and REST registry,
preview/apply policy and append-only audit. Existing catalog permissions and
native program eligibility are required; no account grants are changed.

| Tool | Native operation |
| --- | --- |
| `pinterest_local_stores` | `GET /catalogs/{catalog_id}/local_stores` |
| `pinterest_local_store_context` | Fresh owned catalog and store configuration |
| `pinterest_create_local_stores` | `POST /catalogs/{catalog_id}/local_stores` |
| `pinterest_update_local_stores` | `PATCH /catalogs/{catalog_id}/local_stores` |
| `pinterest_delete_local_stores` | `DELETE /catalogs/{catalog_id}/local_stores` |
| `pinterest_local_inventory` | Read-only `POST /catalogs/{catalog_id}/local_inventory_items/query` |
| `pinterest_local_inventory_context` | Current stores, inventory and exact request |
| `pinterest_create_local_inventory` | Local inventory batch `CREATE` |
| `pinterest_update_local_inventory` | Local inventory batch `UPDATE` |
| `pinterest_upsert_local_inventory` | Local inventory batch `UPSERT` |
| `pinterest_delete_local_inventory` | Local inventory batch `DELETE` |
| `pinterest_apply_local_inventory_batch` | Mixed local inventory operations |
| `pinterest_local_inventory_batch_status` | `GET /catalogs/{catalog_id}/supplemental_items/batch/{batch_id}` |
| `pinterest_reconcile_local_inventory_batch` | Native status plus independent pair readback |

The inventory mutation endpoint is
`POST /catalogs/{catalog_id}/local_inventory_items/batch`. These catalog-ID paths
come from the current pinned OpenAPI. The prose guide still contains older
catalog-less route examples; Adport does not use them or fall back to the token
owner's catalog.

## Stores

List stores with `account_id`, `catalog_id` and optional `store_ids` (up to 100).
The friendly IDs map to native comma-separated `ids`. `page_size` defaults to 25,
with a maximum of 250. Pass `next_cursor` as `bookmark` with identical selection.
The widget appends cards and preserves scroll. Missing native bookmarks leave
completeness unknown; they cannot establish absence.

Store creation requires a merchant `store_code`, `name` and native `country`.
Optional fields cover address, city, region, postal code and coordinates. Store
IDs remain strings even above JavaScript's safe integer range. Adport bounds
batches to 100 stores and 2 MiB, and complete lookups to 10,000 rows. Creation
checks the complete code inventory and catalog capacity before preview and apply.
Existing codes cannot be overwritten. Native concurrent writes are not frozen.

Call `pinterest_local_store_context` with a create, update or delete `action` and
the same `stores` array intended for the write. Pass its hash as
`expected_context_hash`. All writes require `acknowledge_catalog_effects: true`
and `confirm_publication: true`. The normal second call adds only the pending
operation token. Store previews can be approved in the widget.

UPDATE supplies native `id` plus only changed settings. Omitted and unknown native
configuration is independently checked after apply. Changing `store_code` also
requires `acknowledge_store_code_change: true` and complete uniqueness checks;
code swaps are blocked because transient native collisions cannot be assumed
safe. A code change does not promise migration of existing inventory.

DELETE requires `id`, the current `confirm_store_code`, current `confirm_name`
and `confirm_permanent_deletion: true`. A native success must be followed by
absence from a complete ID-filtered list. There is no exposed restore endpoint.
Both native 204 and per-ID 200 responses are handled. Partial/error responses
retain known IDs and safe per-store results without claiming full completion or
automatically replaying the mutation. Store changes can affect inventory and
ads using the catalog; no bid, budget or campaign status is changed.

## Local inventory

An inventory row is identified by **both** `item_id` and `store_code`. Adport
also requires `store_id` to verify that code against the current owned store;
it removes this verification-only field from native query and mutation bodies.
The same SKU at two stores is two distinct records. Local inventory has no
country/language body fields; vertical catalog-item market inputs are not reused.

Read up to 1,000 unique pairs in `item_filters`. `limit` defaults to 24 and allows
up to 100. Continue with `next_cursor` as `cursor` and the same selection. This
pages the requested pairs, not the complete catalog. Native store metadata and
price/availability remain visible. Private ad links are represented by origin
and fingerprint. No media preview, Pin identity or publication state is invented.

To write, call `pinterest_local_inventory_context` with `operations` containing
the pair, `store_id`, `operation` and, except DELETE, `attributes`. Use its hash
with the mixed batch tool, or the matching named tool's `items` array, which
omits `operation`. The same account/catalog/store/project/configuration and exact
request are checked again at apply.

Native attributes are `price`, `availability`, optional `sale_price` and optional
`ad_link`. CREATE and UPSERT require price and availability. UPDATE changes only
supplied attributes and preserves omitted ones. Prices stay strings, including
any currency; no budget-micro conversion or currency default is inserted. Native
availability values are `in stock`, `out of stock` and `preorder`. Nullable clears,
update masks and other attributes are not invented.

UPDATE and DELETE require positively read current pairs. Missing query rows do
not prove absence. CREATE refuses a positively existing pair; an unconfirmed
current pair requires `acknowledge_unconfirmed_existing: true`. Native CREATE
duplicate handling is not an Adport atomic-absence guarantee. UPSERT requires
`acknowledge_replacement: true` and all replacement attributes; unconfirmed
current pairs also require the acknowledgement above.

Every write requires publication and catalog-effect acknowledgements. DELETE
additionally requires permanent-deletion confirmation. Batches contain up to
1,000 unique pairs and 2 MiB. Inventory arguments can contain private ad links,
so context/preview results do not copy them into widget metadata. The agent
performs the second call after review. The widget can display the safe preview
and subsequent **Processing pending** receipt.

## Results

Keep the signed `batch_receipt` for status and reconciliation. It binds the
application, advertiser, catalog, owner context, private project scope and exact
pair manifest. Normal OAuth refresh rotation preserves it; current catalog
ownership is still required. Its 30-day Adport expiry does not promise Pinterest's
native retention period. Opaque native batch IDs are preserved without numeric
coercion, including on malformed mutation responses.

Overall batch status and per-pair results remain separate: `COMPLETED` can include
failed or missing pairs. Reconciliation independently checks requested attributes
and omitted UPDATE fields. Missing pairs after DELETE leave independent absence
unconfirmed. HTTP 401/403 readback is unavailable, not successful. Native diagnostic
codes and attributes remain visible; freeform messages and source URLs are hidden.
No mutation is automatically replayed after failure or uncertainty, and neither
native success nor configuration readback proves ad eligibility or publication.

Contracts were inspected 2026-11-06 against the [Pinterest-owned OpenAPI
5.28.0](https://github.com/pinterest/api-description/blob/51aca009f10a90283ccdf3956d509fc995ebac23/v5/openapi.json).
Wire, shared-policy and simulated host-bridge tests exercise these paths. Native
catalog access/mutations and actual Claude/ChatGPT verification remain separate
requirements; a passing contract test is not proof of them.

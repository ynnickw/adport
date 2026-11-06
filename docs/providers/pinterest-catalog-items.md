# Pinterest catalog items

Agents can create, update, replace or delete items in an explicitly selected
retail, hotel or Creative Assets catalog. They can use files from the central
Adport media library and edit item copy from the creative preview widget.
MCP, CLI and REST use the same registry, policy preview/apply and audit log.
Catalog access still requires the separate native catalog grant and eligibility.

| Tool | Operation |
| --- | --- |
| `pinterest_catalog_item_schema` | On-demand native attributes by catalog type and operation |
| `pinterest_catalog_items` | `POST /catalogs/items`, a read query with paged previews |
| `pinterest_catalog_item_context` | Fresh catalog, owner, market, item and media checks |
| `pinterest_create_catalog_items` | Native batch `CREATE` |
| `pinterest_update_catalog_items` | Native batch `UPDATE` |
| `pinterest_upsert_catalog_items` | Native batch `UPSERT`, full replacement |
| `pinterest_delete_catalog_items` | Native batch `DELETE` across all data sources |
| `pinterest_apply_catalog_items_batch` | Mixed operations in one native batch |
| `pinterest_update_catalog_item_copy` | Snapshot-bound title/name or description update |
| `pinterest_catalog_item_batch_status` | `GET /catalogs/items/batch/{batch_id}` with a signed receipt |
| `pinterest_reconcile_catalog_item_batch` | Status plus independent scoped item readback |

## Read and edit

Every item workflow requires an `account_id`, `catalog_id`, `country` and
`language`. The native ID is passed as a string without numeric coercion. Adport
always sends the selected catalog, including on the read-only POST query;
Pinterest's implicit oldest-catalog fallback is never used.

Pass up to 1,000 unique `item_ids` to `pinterest_catalog_items`. `limit` defaults
to 24, with a maximum of 100; use the returned `next_cursor` as `cursor` with the
same selection. This pages the requested IDs, not the whole catalog. The widget
appends cards without replacing existing cards or resetting scroll. Native Pin
thumbnails appear when supplied by Pinterest. No preview, Pin identity or
publication state is invented. Source links are represented by origin and
fingerprint rather than exposing private paths and query values.

An item's three-dot menu offers **Edit copy**. It binds the selected project,
account, catalog, market, source ID and current snapshot to the same guarded
preview/apply workflow as an agent call. Other attributes remain unchanged.
Hotel copy uses native `name`; retail and Creative Assets use `title`.

Missing rows and native item errors do not establish absence or ownership.
UPDATE and DELETE require positively read current items. CREATE uses Pinterest's
atomic create semantics, which reject an existing item instead of overwriting it;
an unconfirmed preflight item is still disclosed as unconfirmed. UPSERT requires
`acknowledge_replacement: true`; an unconfirmed current item additionally requires
`acknowledge_unconfirmed_existing: true`.

## Prepare a batch

Read `pinterest_catalog_item_schema` for the exact catalog type and operation.
The pinned models include 108 retail CREATE/UPSERT fields and 103 UPDATE fields,
20/17 hotel fields and 15/12 Creative Assets fields. Native nullable values,
enums and types are retained; no default attributes are inserted. Unknown fields
are rejected. Integer values must be safely representable; merchant IDs and
string prices retain their native representation. Merchant-required fields and
endpoint eligibility remain Pinterest's responsibility.

Call `pinterest_catalog_item_context` with `operations`, each containing
`source_id`, `operation` and, except DELETE, `attributes`. Up to 1,000 unique
items and 2 MiB of serialized request data are allowed. Use smaller batches when
the signed proof bound would be exceeded. The returned `context_hash` binds the
exact request, current catalog/type/owner, market, items and media scope.

Pass that hash as `expected_context_hash` to the mixed batch tool, or use the
matching named tool with `items` that omit `operation`. Both use the same native
`POST /catalogs/items/batch` plan. All writes require `confirm_publication: true`
and `acknowledge_catalog_effects: true`, since catalog changes can publish product
Pins or affect ads and groups using those items. DELETE additionally requires
`confirm_permanent_deletion: true`. The normal second call must preserve every
argument and add only the pending operation token.

UPDATE preserves omitted attributes. Retail UPDATE supports explicit
`clear_fields` from the native update-mask enum; a field cannot be both supplied
and cleared. When using clears, all supplied fields must also be representable
in that mask. Hotel and Creative Assets clearing is not inferred. Primary media
fields differ between CREATE/UPSERT and UPDATE; use the operation's schema.
DELETE's optional `last_updated_time` is retail-only.

## Use central media

Upload through the agent, embedded media widget or dashboard, then reference the
stored `media_id` and `expected_sha256` in `media_assets`. Each reference specifies
an `item_index`, supported native media `field` and, for an array, `image_index`.
Existing URL slots cannot be silently overwritten. Image and video bytes are
verified against the checksum and allowed content type during context, preview
and apply. Supported fields include primary media, additional retail images,
hotel `main_image.link` and supported retail ad image/video links.

Preview creates no provider URL grant. Approved apply mints a private HTTPS
retrieval link through the existing media resolver and discloses its expiry.
The hosted resolver currently grants one hour; the batch requires more than ten
minutes remaining. Pinterest's asynchronous retrieval can outlast that lease.
This flow does not promise permanent media hosting or completed ingestion. Inspect
native item errors before preparing another approval; no failed batch is replayed
automatically. Raw source links and native diagnostic messages are hidden from
widget results; codes, attributes and message presence remain available.

## Processing and readback

Submission returns **Processing pending** with the native batch ID and signed
`batch_receipt`. Keep the receipt to call status or reconciliation. It binds the
original advertiser, catalog/type, market, project media scope, owner context and
per-item requested configuration. The signature uses the current Pinterest
application credential, independently of normal OAuth refresh-token rotation.
Its 30-day expiry is an Adport proof lifetime, not a promise of native retention.
Current catalog access and ownership are checked again on every status call.

Batch status, each item's status, independent configuration readback and Pin/ad
readiness are separate observations. `COMPLETED` can contain failed or missing
item results. Reconciliation checks requested fields and preserves omitted UPDATE
fields. A missing/error response after DELETE leaves absence unconfirmed; it is
not independent deletion proof. HTTP 401/403 readback remains an unavailable
observation. Uncertain native outcomes retain known batch IDs and are never
automatically retried. There is no native atomic conditional update.

This implements vertical retail/hotel/Creative Assets item batches. Legacy
oldest-catalog `DELETE_DISCONTINUED`, local inventory, bulk product-group methods
and flexible campaign budgeting remain separate gaps. Native catalog permission
and mutation checks, and actual Claude/ChatGPT host tests, remain pending;
contract, policy and simulated host-bridge tests do not establish them.

Contracts inspected 2026-11-06 against the [Pinterest-owned OpenAPI
5.28.0](https://github.com/pinterest/api-description/blob/51aca009f10a90283ccdf3956d509fc995ebac23/v5/openapi.json)
and the official [catalog batch guide](https://developers.pinterest.com/docs/work-with-catalogs/modify-items-in-batch/).

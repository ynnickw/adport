# Pinterest product groups

Product groups select existing catalog items. They do not upload source items,
publish Pins or activate ads. All tools share the MCP, CLI and REST registry.
Mutations use the normal preview/apply policy and append-only audit.

| Tool | Native operation |
| --- | --- |
| `pinterest_product_group_filter_schema` | Local pinned schema discovery |
| `pinterest_product_groups` | `GET /catalogs/product_groups` |
| `pinterest_get_product_group` | `GET /catalogs/product_groups/{id}` |
| `pinterest_product_group_counts` | `GET /catalogs/product_groups/{id}/product_counts` |
| `pinterest_product_group_products` | `GET /catalogs/product_groups/{id}/products` |
| `pinterest_product_group_context` | Fresh owned catalog/group/feed/reference reads |
| `pinterest_create_product_group` | `POST /catalogs/product_groups` |
| `pinterest_update_product_group` | `PATCH /catalogs/product_groups/{id}` |
| `pinterest_delete_product_group` | `DELETE /catalogs/product_groups/{id}` |

Catalog access requires the existing separate `catalogs:read` / `catalogs:write`
grant and native advertiser-owner access. Pin-management consent does not grant
catalog access. Every request carries the exact selected `ad_account_id`; there
is no fallback to the token owner's catalogs. Native catalog ID/type and group
ID must match. No tool grants account, catalog or Business Center access.

## Browse and select

Reads require `account_id` and `catalog_id`; exact group reads also require
`product_group_id`. Lists support optional retail `feed_id` and up to 100
`product_group_ids`. This friendly input maps to Pinterest's comma-separated `id`
query parameter, preserving string IDs without numeric coercion.
List/product pages accept `page_size` up to 250 and an opaque `next_cursor` as
`bookmark`. Cursors bind the account, catalog, filters
and page size. Product cursors also bind the current group configuration.
The widget appends records without replacing existing cards or resetting scroll.
Missing native bookmarks leave completeness unknown.

Products retain native source IDs and product/Pin fields. Adport does not invent
preview URLs or infer publication state. Same-SKU variants receive distinct
stable record identities from their native metadata. Counts are a separate
observation; they are not a frozen membership snapshot or proof of ad eligibility.

## Author filters through the agent

Call `pinterest_product_group_filter_schema` for the catalog type. The on-demand
schema supplies exact native field names, criteria nesting and enums: 35 retail,
10 hotel and 16 Creative Assets fields. The same Zod schemas validate every
requested filter before preview or apply. Unknown fields and malformed criteria
are rejected, not dropped. `any_of` and `all_of` have distinct native semantics;
each clause contains exactly one field. Category paths retain their order.
Price/currency criteria pass through unchanged without budget-micro conversion.

Adport bounds filters to 32 clauses, 100 values per criterion, 1,024 characters
per value and 256 KiB serialized filters. Empty retail write filters are forbidden
by the native contract. Empty hotel/Creative Assets selections require explicit
`confirm_all_products: true`. Existing automatic groups with empty filters remain
readable. Transitive `PRODUCT_GROUP` references must be owned in the same catalog
and, for a feed-based operation, the same feed. Cycles and more than 40 referenced
groups stop the operation.

## Preview and apply

Call `pinterest_product_group_context` with the selected account/catalog and an
`action`:

- `{ kind: "create", definition }`
- `{ kind: "update", product_group_id, changes }`
- `{ kind: "delete", product_group_id, confirm_name }`

Pass its `context_hash` as `expected_context_hash` to the corresponding write
tool. It binds the exact requested action, current group configuration, advertiser
owner, selected catalog, feed snapshot and transitive filter references. All are
rechecked before apply. Volatile native timestamps are excluded.

A creation `definition` requires `mode`, `catalog_type`, `name` and `filters`.
`FEED` mode supports retail with `feed_id` and sends the native feed-based body.
`CATALOG` mode supports retail, hotel and Creative Assets and sends the native
catalog-based body. Retail catalog-based groups support optional `country` and
`locale`; partner eligibility remains native. Creative Assets access is restricted
by Pinterest. Optional descriptions can be explicitly cleared with `null`.

Updates require `acknowledge_live_effects: true` and change only supplied
name/description/filter or supported country/locale fields. Omitted native
configuration is independently verified after apply. Automatically generated
retail/hotel groups are read-only; only `MERCHANT_CREATED` groups can be changed.
The Creative Assets response has no documented equivalent type discriminator.

Deletion additionally requires the exact current `confirm_name` and
`confirm_permanent_deletion: true`. It can affect ads using the group. Source
items remain in the catalog. A successful native deletion must be followed by
absence from a complete group-ID-filtered list; a bare HTTP success, missing
bookmark or denied readback is not sufficient. Uncertain outcomes retain known
IDs and are never automatically replayed.

Configuration readback does not prove final matched inventory, item readiness,
Pin publication or ad serving. There is no atomic native compare-and-set. Item
batch authoring is covered by [catalog items](pinterest-catalog-items.md). Bulk
group operations, local inventory and flexible campaign budgeting remain
separate gaps.

Wire, shared-policy and synthetic MCP SDK/widget tests cover these flows.
Positive native product-group mutations and actual Claude/ChatGPT host checks
remain pending. Contracts inspected 2026-11-06 against the [Pinterest-owned
OpenAPI 5.28.0](https://github.com/pinterest/api-description/blob/51aca009f10a90283ccdf3956d509fc995ebac23/v5/openapi.json).

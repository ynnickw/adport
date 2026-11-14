# TikTok JSON catalog products

These specialist tools share the normal MCP, CLI and REST registry. An enabled advertiser alone does not authorize Business Center catalogs: every operation also requires an explicit project catalog grant. Writes use the ordinary policy preview, pending token, identical arguments, ownership checks and audit trail. Previews are local (`serverValidated: false`).

| Tool | Native operation |
| --- | --- |
| `tiktok_catalog_product_schema` | Read an authorized catalog's type and its on-demand upload/update structural schema |
| `tiktok_catalog_product_context` | `GET /catalog/product/get/` for exact native product IDs, plus catalog/feed verification |
| `tiktok_upsert_catalog_products` | `POST /catalog/product/upload/` |
| `tiktok_update_catalog_products` | `POST /catalog/product/update/` |
| `tiktok_delete_catalog_products` | `POST /catalog/product/delete/` |

Schema discovery covers ECOM, HOTEL, FLIGHT, DESTINATION, ENTERTAINMENT, AUTO_VEHICLE, AUTO_MODEL, MINI_SERIES, GENERIC and ONLINE_TO_OFFLINE. Native field names, nesting, types, unconditional required create fields and documented enum/length facts are preserved. Unknown fields are rejected. The schema is structural: native conditional requirements, ranges, media audit, permissions and eligibility remain authoritative. This does not add the separate catalog-video management or catalog event-source APIs.

## Inspect and edit

Read `tiktok_catalog_product_schema` with the catalog scope and `operation: upload` or `update`. Heavy field references stay on demand. The mutation payload's `catalog_type` must equal the actual granted catalog's native type.

For edits/removal, read `tiktok_catalog_product_context` with `account_id`, `bc_id`, `catalog_id`, `feed_id` and exact native `product_ids`. It returns `expected_catalog_hash`, `expected_feed_hash` and `products_hash`. Supply that last value as `expected_products_hash`. Selection snapshots include editable native configuration and external identity; volatile audit/delivery fields are excluded. URL fields are returned as origins and SHA-256 fingerprints, not reusable credentials or download grants. Missing native fields remain unavailable.

Exact selections are chunked into at most 1,000 native IDs per request and paged at 100 rows, supporting up to 5,000 selected products. Every requested ID must be found in the correct scope. Foreign, duplicate, unsafe or contradictory IDs/page metadata reject the selection; a partial lookup is never reported as a complete catalog inventory. Native feed membership is checked during processing; verifying a selected feed does not prove that every product belongs to it. A conflicting feed ID, when reported on a product, is rejected locally.

`tiktok_update_catalog_products` takes `updates: [{ product_id, fields }]`. It derives the external identity from native context, rejects attempts to edit it, and sends only supplied top-level fields plus that identity. Reviews show observed before/after values, limited to 20 products and 40 editable fields with a truncation notice; the entire approved payload remains hash-bound. Nested-object merge semantics remain native; Adport does not infer that omitted nested fields are preserved. Apply rechecks catalog/feed/product hashes. No atomic compare-and-set is available here: concurrent native edits remain possible.

`tiktok_upsert_catalog_products` takes native `products` matching the type's upload schema. Upload is incremental **upsert**, not a guarantee of new-only creation: matching external identities can replace product data. It requires `acknowledge_replacement: true`, fresh catalog/feed hashes, `acknowledge_shared_effects: true` and `acknowledge_async_processing: true`. Upserts/updates support the native 5,000-product limit, with an Adport 2 MiB/depth/node bound; use smaller batches when necessary.

For flights, the external update/upload identity is the origin/destination airport pair. TikTok generates `flight_id`; Adport does not invent one or allow changing the pair in a field patch. Removal maps verified native `flight_id` values to `flight_ids`.

## Use centrally stored Adport media

Upload files through Adport's agent media tools or the existing dashboard/widget uploader, then reuse their immutable IDs and checksums in `media_assets`. Each reference selects a zero-based `product_index`, `field`, `media_id` and `expected_sha256`. Supported fields are `image_url`, `video_url` and `additional_image_urls`; additional images also require contiguous `image_index` values starting at zero. A field uses either native source URLs or Adport media references. Unsupported fields for a particular catalog type still reject.

For example, omit `image_url` from the first native product and supply:

```json
{
  "media_assets": [{
    "product_index": 0,
    "field": "image_url",
    "media_id": "11111111-1111-4111-8111-111111111111",
    "expected_sha256": "<the stored file SHA-256>"
  }]
}
```

For updates, indexes refer to the `updates` array. A media-only patch may use an empty `fields` object. Image references accept PNG/JPEG bytes; video references use stored video media. Byte/type/checksum verification runs at preview and apply, with repeated references resolved once per phase. Private HTTPS download grants are minted only during apply, require a verified checksum and at least ten minutes of remaining validity, and stay out of previews, responses, audits and operation arguments returned to widgets. The logical payload hash binds immutable media references, not expiring URLs.

Images must meet TikTok's 500×500 minimum and other native image requirements. Grants expire: native fetching/audit and any ongoing source refetch behavior require live verification. Accepted processing does not establish that media was fetched or copied successfully. Receipts retain `source_media_assets` for follow-up. No dashboard redirect is needed to select or submit stored media.

Native JSON product/update arguments can contain private source URLs, so their approval arguments are withheld from widgets. The widget displays the sanitized review; the agent applies the identical original arguments plus `pending_operation_id`. Removal arguments contain selected IDs/hashes and support the existing hold-to-apply widget. Catalog/source tools do not add a separate organization/distribution UI.

## Removal and processing

Removal requires selected product context, `acknowledge_removal: true` and the same shared/async acknowledgements. It maps verified external IDs to documented `sku_ids`, `hotel_ids`, `flight_ids`, `destination_ids`, `vehicle_ids`, `series_ids`, `item_ids` or `listing_ids`. Native limits are 1,000 except 10,000 for generic/online-to-offline; this workflow's selection cap is 5,000. The official delete contract does not document an Entertainment selector, so that removal is refused rather than inventing `media_title_ids`. Removal can affect existing ads; it does not directly activate or pause them.

Each apply submits once and returns an accepted `feed_log_id`, with `processed: false` and exact arguments for `tiktok_catalog_product_log`. Adport independently checks that job's catalog/feed binding. Failed/item-error jobs or failed readback retain the known job ID in an unconfirmed error. Native permission/transport errors and missing/unsafe IDs are not retried automatically. TikTok allows one active product operation per catalog; inspect prior jobs before sending another.

Poll the exact job until terminal, inspect native error/warning counts, then read selected product configuration again. Processing success, intended field changes, media audit and ad eligibility are separate facts. This workflow does not infer final ingestion from acceptance or claim an atomic usage lock across other accounts using the catalog.

Contracts refreshed from current official docs: [upload](https://business-api.tiktok.com/portal/docs?id=1740497429681153), [update](https://business-api.tiktok.com/portal/docs?id=1740562287852546), [get](https://business-api.tiktok.com/portal/docs?id=1740564136678402), [remove](https://business-api.tiktok.com/portal/docs?id=1740562489236481), and [processing log](https://business-api.tiktok.com/portal/docs?id=1740570027173889). Contract and synthetic SDK/widget checks do not establish successful native account mutations or actual Claude/ChatGPT execution.

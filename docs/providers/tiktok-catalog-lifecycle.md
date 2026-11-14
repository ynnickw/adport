# TikTok catalog creation and deletion

Agents can create empty catalogs and delete explicitly writable catalogs through
the shared MCP, CLI and REST registry. Native writes use the normal preview,
pending-operation token, account policy and audit path. They create no ads,
products, tracking events or spend.

| Tool | Native v1.3 operation |
| --- | --- |
| `tiktok_catalog_creation_context` | Read the exact creation delegation and `GET /catalog/available_country/get/` |
| `tiktok_create_catalog` | `POST /catalog/create/`, exact-ID configuration readback, then adoption of that new ID |
| `tiktok_delete_catalog` | `POST /catalog/delete/`, followed by exact filtered catalog absence |

## Owner delegation

Creation is separate from read/write access to an existing catalog. A project
owner/admin can open **Accounts → TikTok catalog access**, select the advertiser,
choose **New catalogs**, enter the exact Business Center ID and select
**Create and manage new catalogs**. Review and confirm the normal guarded access
change. Adport checks the native region endpoint for that exact Business Center;
this does not certify native catalog creation eligibility or grant TikTok user
permissions.

This delegates creation in the selected project/advertiser/Business Center and
read/write management of verified new catalog IDs. It does not enumerate or
authorize existing Business Center catalogs. To use an existing catalog, grant
that exact catalog separately. Revoking creation delegation leaves previously
adopted catalog grants independent; revoke those separately when appropriate.
Creation delegation can be revoked after advertiser disablement/disconnection,
without native credentials. New grants require an enabled, connected advertiser.

MCP/API tokens cannot administer their own grants. The owner route requires a
signed-in owner/admin, `connections:manage`, a valid origin and an exact reviewed
hash/token. It registers only permission administration and cannot invoke native
creation/deletion. The local CLI/stdio owner uses the existing
`tiktok_catalog_access_snapshot` and `tiktok_set_catalog_access` with
`resource_kind: "catalog_creation"`, `bc_id`, and `mode: "create"` or `"none"`.
Omit `catalog_id` for creation delegation. Existing catalog grants keep their
read/write/none selection and exact `catalog_id`.

## Agent creation

1. Read `tiktok_catalog_creation_context` with `project_id`, `account_id` and
   `bc_id`. Keep `expected_creation_access_hash` and `expected_regions_hash`.
2. Request a `tiktok_create_catalog` preview with those arguments/hashes, `name`,
   `catalog_type`, `catalog_conf`, and `acknowledge_new_catalog_management: true`.
3. Review the immutable configuration and new catalog's project access. Apply
   the identical arguments with its `pending_operation_id` after approval.
4. Use the returned catalog ID with the normal catalog/product/feed/video tools.
   Their exact resource grant is available only after successful native readback
   and adoption.

The structural schema supports all ten documented catalog types: `ECOM`,
`HOTEL`, `FLIGHT`, `DESTINATION`, `ENTERTAINMENT`, `AUTO_VEHICLE`, `AUTO_MODEL`,
`MINI_SERIES`, `GENERIC` and `ONLINE_TO_OFFLINE`. This does not establish native
eligibility for every type. Entertainment and mini-series require allowlisting,
as do some multi-country types. Native type-specific region/currency rules are
authoritative.

`catalog_conf.currency` is required. For `ECOM`, `HOTEL`, `FLIGHT` and
`DESTINATION`, Adport requires an explicit `is_multi_country` choice even though
TikTok defaults it to false. Single-country catalogs require `region_code`;
multi-country catalogs omit it. Other types omit `is_multi_country`. Optional
`channel` accepts `PARTNER` or `CLIENT`; omitted channel uses the native default.
Only `MINI_SERIES` accepts `additional_config_list` with distinct additional
region/currency pairs. Adport bounds that list to 100 entries. Chosen regions
must appear in the current native Business Center region response.

The preview includes the immutable type, region, currency, channel, additional
regions and new project read/write access. Apply rechecks the delegation and
region snapshot, sends one create, independently verifies the returned catalog
ID/Business Center/configuration, and then adopts that ID. Readback maps native
`catalog_conf.country` to the creation request's `region_code`; additional
region order is not significant. Missing/different selected configuration leaves
the outcome unconfirmed.

Adoption rechecks active account and exact creation delegation inside the private
store transaction. It cannot overwrite any existing catalog grant or revocation
tombstone. Owner changes and adoption use the same lock order; stale/revoked
creation permissions cannot authorize a later adoption. Private tables retain
RLS and have no `anon`/`authenticated` privileges. Local files use scope hashes,
private permissions and creation/child resource locks.

Native creation and the local access receipt are not one atomic transaction.
If native creation succeeds but readback/adoption fails, the error retains its
known ID. Reconcile that catalog and owner access before another create; no
request is automatically replayed. Do not infer failure means no catalog exists.

## Permanent deletion

Read `tiktok_get_catalog`, then request `tiktok_delete_catalog` with its current
`configuration_hash` as `expected_configuration_hash`, exact
`confirm_catalog_name`, `acknowledge_shared_effects: true` and
`acknowledge_delete_products_and_feeds: true`, alongside the normal scope.
The review identifies the catalog/Business Center/type and whole-container
impact. Apply uses the identical arguments and pending token.

Deletion affects the whole shared catalog and its current contents, including
products and feeds; existing ads or other consumers may be affected. The
configuration snapshot does not enumerate or freeze dependent contents. No
native restore endpoint or global/atomic usage guarantee is claimed. Apply
rechecks configuration/name/access, verifies the native deletion receipt ID, and
independently checks absence from the exact filtered catalog view. Native
permission errors and contradictory pagination remain errors, not absence.
Uncertain results retain the catalog ID and are never replayed. Adport catalog
access remains a separate owner setting and can be revoked without native access.

Contracts were refreshed on 2026-11-05 from official docs:
[create](https://business-api.tiktok.com/portal/docs?id=1740306481704961),
[delete](https://business-api.tiktok.com/portal/docs?id=1740310064588801),
[available regions](https://business-api.tiktok.com/portal/docs?id=1740491257516034)
and [catalog readback](https://business-api.tiktok.com/portal/docs?id=1740315452868610).
Wire, policy, local-file, isolated Postgres, owner route/UI and synthetic
OpenAI/MCP widget tests cover these paths. Positive native creation/deletion and
actual Claude/ChatGPT host checks remain pending.

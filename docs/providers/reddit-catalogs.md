# Reddit Business catalogs

Adport exposes exact Business catalog configuration through the same MCP, CLI
and REST tool registry. Every mutation uses the normal preview, identical
arguments, pending token, account policy and audit log. Reddit provides no
server dry-run for these operations.

| Tool | Native v3 operation |
| --- | --- |
| `reddit_catalog_access` | Read this project's explicit grants; no native Business catalog enumeration |
| `reddit_get_catalog` | `GET /product_catalogs/{catalog_id}` |
| `reddit_catalog_creation_context` | Exact creation delegation, `GET /businesses/{business_id}` and selected account Pixels |
| `reddit_create_catalog` | `POST /businesses/{business_id}/product_catalogs`, independent exact readback and new-ID adoption |
| `reddit_rename_catalog` | `PATCH /product_catalogs/{catalog_id}` with only `name` |
| `reddit_catalog_event_source_context` | Exact catalog snapshot and selected account Pixel availability |
| `reddit_set_catalog_event_sources` | `PATCH /product_catalogs/{catalog_id}` with the entire `event_sources` array |
| `reddit_delete_catalog` | `DELETE /product_catalogs/{catalog_id}`, then exact lookup absence |

## Project access

An enabled Reddit advertiser does not grant access to every Business catalog.
A signed-in project owner/admin chooses **Accounts → Reddit catalog access**,
the imported advertiser and the exact Business/catalog. Review and confirm
**Read** or **Read and write** access. Business IDs use Reddit's documented UUID
shape; catalog and advertiser IDs remain opaque strings. Native credentials
must independently permit access to that Business/catalog.

Choose **New catalogs** and **Create and manage new catalogs** to delegate
creation in one exact project/advertiser/Business. This authorizes management
only of new IDs independently verified after creation. Existing catalogs are
neither enumerated nor granted. Revoking creation leaves separate catalog grants
intact. Revocation remains available after advertiser disablement/disconnection;
new grants require an enabled, connected advertiser.

Hosted MCP/API tokens cannot administer their own grants. The owner route
requires a signed-in owner/admin with `connections:manage`, checks origin and
binds approvals to the exact vendor/scope/hash. Its restricted runtime cannot
mutate native resources. Local owners use `reddit_catalog_access_snapshot` and
`reddit_set_catalog_access`, with `business_id`, `resource_kind:
"catalog_creation"`, no `catalog_id`, and mode `create` or `none`. Existing
catalog grants use exact `catalog_id` and mode `read`, `write` or `none`.

Private cloud grants have RLS, no public/client-role privileges and revisioned
updates. Owner changes and new-ID adoption use consistent transaction locks.
Adoption rechecks active account and creation delegation and cannot overwrite an
existing owner decision, including a revocation tombstone. Local grants use
private files and scope-bound hashes.

## Create and edit

1. Read `reddit_catalog_creation_context` using `project_id`, `account_id`,
   `business_id` and optional selected `event_sources` (Pixel IDs).
2. Preview `reddit_create_catalog` with the returned
   `expected_creation_access_hash` and `expected_event_sources_hash`, `name`,
   `default_currency`, `default_language`, the identical source selection and
   `acknowledge_new_catalog_management: true`.
3. Review and apply identical arguments with `pending_operation_id`.

Creation supports the documented languages `en`, `de`, `es`, `fr`, `it`, `pt`
and currencies `USD`, `GBP`, `CAD`, `EUR`, `AUD`, `JPY`, `CHF`, `NZD`, `SEK`,
`NOK`, `BRL`. Native eligibility remains authoritative. Defaults are not
patchable through this catalog endpoint. The request creates an empty catalog;
it submits no products, ads, conversion events or spend.

Adport verifies the native creation receipt, exact ID/Business/defaults/sources
through an independent lookup, then adopts that ID for project read/write
access. Native creation and project adoption are not atomic. If either readback
or adoption fails, reconcile any known ID before another create. Requests are
never automatically replayed.

For rename, read `reddit_get_catalog`, then preview `reddit_rename_catalog`
using `expected_configuration_hash`, `name` and
`acknowledge_shared_effects: true`. The native PATCH contains only the name;
readback checks preserved defaults and event sources. Missing native fields
remain unavailable, and preservation-dependent edits refuse missing source
configuration. Product counts and volatile timestamps do not affect the
configuration hash.

For source replacement, read `reddit_catalog_event_source_context` with the
entire intended `event_sources` list. Preview `reddit_set_catalog_event_sources`
with both returned hashes and explicit shared/measurement-effects
acknowledgements. An empty array explicitly clears all bindings. Selected IDs
are checked through `GET /ad_accounts/{account_id}/pixels`; this is positive
membership evidence within a 5,000-row local bound, not a complete Pixel
inventory. Adport accepts up to 100 unique selected IDs, each up to 50 characters.
No Pixel script or conversion event is returned or submitted. Shared matching
and existing ads may be affected.

## Delete and limits

Read the exact catalog, then preview `reddit_delete_catalog` with its current
`expected_configuration_hash`, exact `confirm_catalog_name`,
`acknowledge_shared_effects: true` and `acknowledge_delete_contents: true`.
Review the entire shared-container impact before applying identical arguments.
Contents and consumers are not enumerated or frozen. Native DELETE returns
204; Adport independently checks exact GET 404. Permission errors and other
failures do not count as absence. Uncertain results retain known IDs and are
not replayed. Project grants remain separate owner settings.

[Product views, set management and import diagnostics](reddit-catalog-content.md)
and [feed management](reddit-catalog-feeds.md) use these same exact catalog grants.
Manual product mutations remain outstanding. This is catalog configuration coverage, not full
Reddit API coverage. Wire/policy tests, isolated Postgres checks, owner-route/UI tests and
synthetic OpenAI/MCP widget bridges cover these workflows. Positive native
catalog mutations and actual Claude/ChatGPT host execution remain unverified.

Contract source: [official Reddit v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json),
refreshed 2026-11-05.

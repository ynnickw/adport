# Reddit catalog feeds

Feed management uses the shared MCP, CLI and REST registry and the normal
preview/apply policy gate. First select the exact project/account/Business/catalog
grant described in [Business catalogs](reddit-catalogs.md). Enabling an
advertiser does not authorize all Business assets.

| Tool | Native v3 operation |
| --- | --- |
| `reddit_catalog_feeds` | `GET /product_catalogs/{catalog_id}/product_feeds` |
| `reddit_get_catalog_feed` | `GET /product_feeds/{feed_id}` |
| `reddit_create_catalog_feed` | `POST /product_catalogs/{catalog_id}/product_feeds` |
| `reddit_update_catalog_feed` | `PATCH /product_feeds/{feed_id}` |
| `reddit_set_catalog_feed_schedule_status` | `PATCH /product_feeds/{feed_id}` with verified schedule timing and changed `is_paused` |
| `reddit_delete_catalog_feed` | `DELETE /product_feeds/{feed_id}`, then exact native lookup absence |

## Read configuration

Use `project_id`, `account_id`, `business_id` and `catalog_id`. An exact feed also
needs `feed_id`. Every read verifies the parent catalog's native Business and
every returned feed's catalog relationship. Global feed IDs cannot bypass the
selected catalog grant.

Reddit returns an unpaged feed list. Adport bounds it to 5,000, then pages a
configuration snapshot locally with `page_size` (default 20, maximum 100) and a
returned `cursor`. Source/mode/schedule changes invalidate the snapshot rather
than mixing configurations across pages. A native continuation on this
documented unpaged route is rejected. Counts and native feed eligibility remain
authoritative; this is not a product inventory.

Results include a safe source origin, fingerprint, reported schedule and
`configuration_hash`. Source paths, query values, usernames, passwords and
unknown native fields are omitted. Names containing known source credentials
are redacted. Missing schedule metadata remains unavailable; it is not inferred
as paused or absent. Authentication values are excluded from configuration
hashes, so authentication-only changes are not detectable through that hash.
Volatile `next_import_at` values are excluded as well.

## Create and update

1. Read `reddit_get_catalog` and retain its `configuration_hash`.
2. Preview `reddit_create_catalog_feed` with exact scope,
   `expected_catalog_configuration_hash`, `url`, explicit native `mode`,
   explicit `schedule` or `null`, and the shared/automatic-processing
   acknowledgements. Optional native fields include `name`, `username` and
   `password`.
3. Review the redacted configuration, then use the agent to apply identical
   arguments with the returned `pending_operation_id`.

Source URLs support externally hosted HTTPS, FTP and SFTP. Embedded credentials,
fragments, whitespace and literal private/local hosts are rejected. Adport does
not fetch the source or forward Reddit API credentials to its host. Username
and password are separate native fields, each up to 100 characters. Null
explicitly clears a field; omitted authentication fields are not sent.

Choose native `REPLACE` or `UPDATE` explicitly. The current OpenAPI describes the
mode names without a detailed product-retention guarantee. Adport does not
promise that a particular product inventory survives native processing. Source
and schedule changes can affect products consumed by existing ads; inspect
native import results through the [import tools](reddit-catalog-content.md).

An explicit schedule supplies `is_paused`, `interval`, `interval_count`, `hour`,
`minute` and a supported time zone. Intervals are `HOURLY`, `DAILY`, `WEEKLY` or
`MONTHLY`. Weekly schedules also select `day_of_week`; monthly schedules select
`day_of_month`. Inapplicable day fields may be omitted or null. Adport validates
all 596 published native time-zone choices without embedding that entire list
in every MCP schema. No local-machine time zone or hidden timing default is
applied. An explicit null schedule requests no recurring schedule; it does not
establish that native ingestion has never run.

For updates, first read `reddit_get_catalog_feed`, then preview
`reddit_update_catalog_feed` with its current `expected_configuration_hash` and
only selected fields. Source/mode/schedule/authentication changes require
`acknowledge_automatic_processing: true`; all updates require shared-effects
acknowledgement. A supplied schedule replaces timing and must be complete.
Read-only `next_import_at` cannot be supplied. Other source/authentication fields
are omitted from PATCH unless explicitly selected.

Apply verifies native ID/catalog acknowledgement and independently reads back
the selected configuration and preserved fields. Unavailable or unsupported
current schedules refuse preservation-dependent writes. Authentication
readback and successful ingestion are not certified; authentication writes
return that qualification explicitly. Known IDs survive uncertain outcomes.
No mutation is automatically replayed.

## Widget and privacy behavior

Feed URLs, authentication and free-form names are sensitive arguments and stay
out of widget approval metadata. Visible reviews omit raw source URLs and
authentication and redact known source credentials from names. The agent retains
the original arguments and applies them after approval through the same policy
engine. This avoids echoing credentials inside names or copied source URLs.

Source-free mode, schedule status and deletion previews can carry a normal
widget approval. Load more appends metadata cards without rebuilding existing
nodes or discarding scroll. Both synthetic OpenAI and MCP bridges cover these
flows; they do not establish actual Claude/ChatGPT host execution.

Cloud pending operations use the existing encrypted, project-bound store.
Local pending files remain private with mode 0600 and expire normally. Audit
entries contain redacted summaries, resource IDs and qualified outcomes.

## Pause, resume and delete

`reddit_set_catalog_feed_schedule_status` takes exact scope, a fresh feed hash,
the opposite known `is_paused` value and shared/automatic-processing
acknowledgements. It requires a fully reported supported schedule. It sends
current writable timing with the new pause state, omitting source/authentication
and `next_import_at`. This verifies configuration; it does not certify
cancellation or reversal of an existing import.

`reddit_delete_catalog_feed` requires a fresh hash and shared/deletion
acknowledgements. Native DELETE 204 is followed by an exact GET 404. Permission
errors and other failures are not absence. Imported products and dependent ads
are not enumerated or frozen, and their effects require separate inspection.
No restore or automatic compensating write is claimed.

## Source lifetime and verification

The source must remain available for its intended schedule. A one-hour private
Adport media URL is unsuitable for an ongoing recurring feed. These tools do not
create an implicit permanent public lease for private project media or prove
authenticated source access. Configuration readback is separate from ingestion. Source fingerprints identify
the URL, not immutable feed bytes; approval binds the URL/configuration while
remote source contents can change between imports.

Wire, policy, scope, secret-redaction, pagination and synthetic SDK/widget checks
cover these tools. Positive native feed mutations and actual Claude/ChatGPT
execution remain unverified. No events, ad activation or spend are submitted by
these tools.

Contracts refreshed 2026-11-05 from the official
[v3 OpenAPI](https://ads-api.reddit.com/api/v3/openapi.json),
[create feed](https://ads-api.reddit.com/docs/v3/api/create-product-feed),
[update feed](https://ads-api.reddit.com/docs/v3/api/update-product-feed) and
[catalog requirements](https://business.reddithelp.com/articles/Knowledge/catalog-requirements).

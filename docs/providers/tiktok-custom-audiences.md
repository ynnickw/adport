# TikTok custom audiences and customer files

These typed tools share the MCP, CLI and REST registry and the normal
preview/apply policy. Custom audiences contain matched users. A saved targeting
template is a separate resource and does not populate an audience.

See [rule and lookalike audiences](tiktok-audience-authoring.md) for source
discovery, event-based audience creation and owned lookalike refresh.

| Tool | Native v1.3 operation |
| --- | --- |
| `tiktok_custom_audiences` | `GET /dmp/custom_audience/list/` |
| `tiktok_get_custom_audience` | `GET /dmp/custom_audience/get/` |
| `tiktok_upload_audience_file` | `POST /dmp/custom_audience/file/upload/` |
| `tiktok_create_customer_audience` | `POST /dmp/custom_audience/create/` |
| `tiktok_update_customer_audience_users` | `POST /dmp/custom_audience/update/` |
| `tiktok_rename_custom_audience` | `POST /dmp/custom_audience/update/` |
| `tiktok_delete_custom_audiences` | `POST /dmp/custom_audience/delete/` |

## Read ownership and processing state

List audiences with `account_id`, optional `custom_audience_ids` (up to 100),
`page` and `page_size`. Adport retains the existing default of 100 rows and now
enforces TikTok's documented maximum of 100. `list` and `page_info` remain
available alongside widget records. Load more follows `next_page` while
preserving cards and scroll. Missing or contradictory native pagination is
reported as unknown completeness; it cannot prove absence.

Use `tiktok_get_custom_audience` for an exact ID and `snapshot_hash` before a
change. It checks the returned ID and native ownership relationship. Availability,
matched coverage, sharing and expiry flags remain native values; absent values
remain unavailable. Expiry strings are preserved without inferring a reporting
timezone. Native freeform status/error and history messages are not echoed,
because they may contain uploaded identifiers. The response indicates whether
a native error was reported.

Only an audience's creator can modify it. Recipient access to a shared audience
does not establish ownership. Rename and member updates require native
`is_valid: true`, `is_expiring: false` and no reported error. Unavailable,
processing or expiring audiences must be reconciled before another modification.
Owned expired audiences can be selected for deletion. Native eligibility still
applies; a local preview is not a server-side dry run.

## Upload through an agent

1. Upload a private CSV into the Adport project with the media tools, including
   the widget's direct upload, then retain its `media_id` and SHA-256. Local
   CLI/stdio can also use an absolute `.csv` or `.txt` `file_path`.
2. Preview `tiktok_upload_audience_file` with exactly one source, its
   `expected_sha256` and `calculate_type`.
3. Review counts, source checksum and encryption type; apply the same arguments
   with `pending_operation_id`. Identifier values never appear in the preview.
4. Retain `result.details.upload_receipt` for create or member updates.

Files require a lowercase `.csv` or `.txt` suffix, valid UTF-8 CSV structure,
at most 50 MB and 100,000 CSV rows including any header. The native endpoint
supports larger files; Adport's current private media limit is deliberately
retained. Files are read and checksum-verified again during apply. Exact bytes
are sent as multipart `file`, with `advertiser_id`, `calculate_type` and a native
MD5 `file_signature`. The client supplies the multipart boundary; no manually
invented content type or extra file-name parameter is sent.

Supported single-column files contain one already-hashed identifier per row,
without a header. SHA-256 types are `EMAIL_SHA256`, `PHONE_SHA256`,
`IDFA_SHA256`, `GAID_SHA256` and combined mobile-ID type `FIRST_SHA256`.
Documented legacy MD5 types `IDFA_MD5`, `GAID_MD5` and `FIRST_MD5` require
32-character hashes. SHA-256 hashes require 64 hex characters. Uppercase hex is
accepted and the original bytes are retained.

For `MULTIPLE_TYPES`, use unique case-insensitive headers drawn from
`email_SHA256`, `phone_SHA256`, `MAID_SHA256` and `MAID_MD5`. A row may omit a
particular identifier, but must contain at least one valid hash. Raw MAIDs,
email addresses and phone numbers are not accepted. These checks establish
syntax, not normalization quality, data authority, actual people or matches.
Normalize before hashing according to TikTok's identifier guide; Adport does
not silently transform or re-hash identifiers.

Upload receipts bind the native file handle, source hash, encryption type,
row count, credential, production/sandbox environment, advertiser and private
media scope. They are signed, not encrypted; they contain metadata, not customer
identifiers. No raw native file handle is exposed as a separate result field.
Adport receipts expire after 24 hours; this is not a claim about native file
retention. Foreign, altered, expired, duplicate-handle or mixed-type receipts
are rejected before audience creation or mutation. Credential rotation can
invalidate old receipts.

Native upload acceptance has no content-download/readback endpoint here. An
uncertain upload is not retried automatically. It does not create an audience,
activate an ad or submit conversion events.

## Create and manage members

Create with `tiktok_create_customer_audience`, a name, and 1–49 distinct
`upload_receipts` of the same encryption type. Optional subtype and retention
follow the documented API. Audience enhancement is explicitly disabled, shown
in the preview and sent as `false`; uploaded customers are not silently expanded.
The returned ID, ownership, name, type, encryption and subtype are independently
read back. Requested retention and the reported native expiry are shown
separately; exact retention/membership is not inferred from metadata.

For `tiktok_update_customer_audience_users`, supply the current
`expected_snapshot_hash`, approved receipts and an explicit `APPEND`, `REMOVE`
or `REPLACE` action. No default replacement is allowed. Reviews explain that
APPEND retains existing members, REMOVE removes matching members, and REPLACE
replaces the entire membership. The tool requires an owned available Customer
File Audience with the same encryption type as the receipts.

TikTok documents 24 member-update operations per consecutive 24 hours and one
replace per day at audience level. Operations can fail if the resulting audience
has fewer than 1,000 matched users; REMOVE cannot empty the audience. Adport
cannot infer resulting matches or quota availability from file row counts.

Create and member-update receipts show **Processing pending** in widgets.
Native processing can take up to 48 hours. The tools check known metadata and
preservation separately from processing acceptance. They do not claim that
individual membership has been read back or that acceptance proves readiness.
Use `tiktok_get_custom_audience` for subsequent native availability/error flags.
Rename is separate: it sends only the selected name and independently verifies
preserved known configuration. Native expiry may reset on eligible modification.

## Delete and shared effects

`tiktok_delete_custom_audiences` requires each selected ID's fresh hash and
exact `confirm_name`, plus shared-effects and permanent-deletion acknowledgements.
All selected ownership/configuration checks pass before one native batch is
sent. A complete filtered native list must then show every ID absent. Missing
pagination, a partial deletion or permission errors are not absence.

Audience mutations can affect current ad groups and shared recipients. Native
expiry can detach audiences and pause campaigns whose only targeting was that
audience. Dependent usage is not enumerated or frozen. There is no
conditional-write, atomic-batch or native restore guarantee. Uncertain writes
retain known IDs, consume the policy approval and are never automatically replayed.
Native bodies, source bytes and identifier values are excluded from failure
diagnostics.

Rule-based and lookalike authoring, audience sharing and the Streaming API are
separate workflows; these customer-file tools do not claim to implement them.
Native positive writes and actual Claude/ChatGPT execution require separate
evidence from wire, policy and synthetic host-bridge tests.

Contracts refreshed 2026-11-06 from TikTok's
[official SDK](https://github.com/tiktok/tiktok-business-api-sdk),
[upload reference](https://business-api.tiktok.com/portal/docs?id=1739940567842818),
[create reference](https://business-api.tiktok.com/portal/docs?id=1739940570793985),
[update reference](https://business-api.tiktok.com/portal/docs?id=1739940572667906),
[details reference](https://business-api.tiktok.com/portal/docs?id=1739940507792385),
[deletion reference](https://business-api.tiktok.com/portal/docs?id=1739940539757569)
and [identifier normalization](https://business-api.tiktok.com/portal/docs?id=1850030360880129).

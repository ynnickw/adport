# TikTok catalog event sources

Agents can inspect, bind and unbind app events and web Pixels in a Business
Center catalog. The catalog requires its own exact project/account/Business
Center grant; enabling an advertiser alone grants no catalog access. See
[catalog access](tiktok.md#project-scoped-catalog-access).

| Tool | Native v1.3 operation |
| --- | --- |
| `tiktok_catalog_event_sources` | `GET /catalog/eventsource_bind/get/` |
| `tiktok_catalog_event_source_apps` | `GET /app/list/` for the selected advertiser |
| `tiktok_catalog_event_source_context` | Catalog/binding reads plus exact `GET /app/info/` and/or code-filtered `GET /pixel/list/` |
| `tiktok_bind_catalog_event_sources` | `POST /catalog/eventsource/bind/`, followed by binding readback |
| `tiktok_unbind_catalog_event_sources` | `POST /catalog/eventsource/unbind/`, followed by binding readback |

The native read path contains `eventsource_bind`; write paths contain
`eventsource/bind` or `eventsource/unbind`. MCP, CLI and REST share the same typed
tool definitions and preview/apply policy. Configuration changes send no events,
install no tracking and do not change ad status or budgets. They can affect
product/event matching, measurement, retargeting and existing catalog ads.

## Discover and select

Use `tiktok_catalog_event_sources` with `project_id`, `account_id`, `bc_id` and
`catalog_id` to inspect current bindings. These are catalog-level bindings:
another advertiser may have bound a source to this shared resource. The list
therefore does not establish selected-advertiser source ownership.

Use `tiktok_catalog_event_source_apps` with the same scope to discover apps under
the selected advertiser. Optional `app_platform_ids` are exact platform-ID
filters. Select the returned **`app_id`** for binding; `app_platform_id` and
`tiktok_app_id` are different identifiers. App discovery does not guarantee that
TikTok will allow a catalog binding.

Use the existing `tiktok_pixels` tool to find an advertiser's web Pixel and its
**`pixel_code`**, with `filtering: { "available_for_catalog_only": true }` for new
bindings. The numeric `pixel_id` is different from this code.

Native catalog-binding and app-list endpoints are unpaged. Adport bounds each
response to 5,000 normalized entries and snapshot-pages it locally, at most 100
records per page. Widgets append with **Load more**, retaining loaded nodes and
scroll. `total_in_response` describes the native response, not global inventory.
Changes to the scoped response invalidate its cursor; restart the first page.
Source names are displayed as text. Tracking URLs, partner tokens, Pixel
scripts, event rules, raw icons and unknown native fields are omitted.

## Preview and apply

1. Call `tiktok_catalog_event_source_context` with the scope, `app_id`,
   `pixel_code`, or both, and `purpose: "bind"` or `"unbind"`. At least one
   explicit selector is required. A single change can include both source kinds.
2. Copy `expected_catalog_hash`, `expected_bindings_hash` and
   `expected_sources_hash` into the matching write call. Add
   `acknowledge_shared_effects: true` and
   `acknowledge_measurement_effects: true`. Omit `purpose` from the write call;
   the chosen tool determines the operation.
3. Review the source names/IDs, catalog and preserved-binding count. Apply the
   identical arguments with its `pending_operation_id` after approval. An
   interactive widget offers the same shared approval flow; the agent can also
   perform it through MCP, CLI or REST without dashboard interaction.

Both context and apply verify the app through the advertiser-scoped `app/info`
endpoint and the Pixel through its exact code under the selected advertiser.
For binding, the Pixel lookup requests native catalog availability. Unbinding
omits that filter because an already bound source may no longer be eligible for
a new binding. Unbound Pixel relationships, foreign echoes, ambiguous lookups,
unsafe identifiers and malformed/contradictory responses are rejected.
Native shared Pixels can be selected when available to the advertiser; the
workflow does not pretend they are advertiser-owned.

New bindings must be absent. Unbind targets must already be present. Mixed
no-op/change requests are rejected rather than silently dropping selectors.
An empty selection never means unbind all. A context prepared for binding cannot
approve unbinding. Source identity/configuration, catalog and binding snapshots
are rechecked before submission; changes require a fresh preview. Native app or
Pixel eligibility and permission enforcement remain authoritative.

Apply sends one exact request with the selected advertiser, Business Center,
catalog and explicit selectors. It then checks that selected identities were
added/removed and every unselected identity survived. Row ordering and source
renaming do not substitute for identity changes. This readback is not an atomic
cross-resource guarantee. A native error, partial change, unexpected receipt or
unconfirmed readback remains an error with known catalog/source IDs. No write
is automatically replayed. Inspect the current bindings before another change.
Read-only catalog grants can inspect context but cannot preview/apply mutations.

Contracts were refreshed from current official docs on 2026-11-05:
[binding information](https://business-api.tiktok.com/portal/docs?id=1740492531343362),
[bind](https://business-api.tiktok.com/portal/docs?id=1740492491200513),
[unbind](https://business-api.tiktok.com/portal/docs?id=1740492512449538),
[app list](https://business-api.tiktok.com/portal/docs?id=1740859313270786),
[app info](https://business-api.tiktok.com/portal/docs?id=1740859272887297) and
[Pixels](https://business-api.tiktok.com/portal/docs?id=1740858697598978).
Request/response, policy, privacy and synthetic dual-bridge widget tests verify
these contracts. Positive native binding checks and actual Claude/ChatGPT host
execution remain pending. No event-ingestion call is part of this workflow.

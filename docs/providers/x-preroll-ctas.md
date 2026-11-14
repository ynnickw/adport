# X preroll CTA settings

Agents can browse, create, edit and remove native preroll call-to-action settings
through the shared MCP, CLI and REST registry. All writes use the normal policy,
preview, pending token and audit path. CTA settings belong to an **ad group** and
can affect all of its current and future preroll ads.

These are specialist tools. A hosted Standard profile may hide them;
`capabilities_list` can discover the workflow and explain connection access.
Discovery does not enable tools or run an operation.

| Tool | Native v12 operation |
| --- | --- |
| `x_preroll_ctas` | Paged `GET accounts/:account_id/preroll_call_to_actions` |
| `x_get_preroll_cta` | Exact CTA GET, parent and complete active CTA inventory |
| `x_preroll_cta_context` | Creation selection, parent/inventory snapshot and context hash |
| `x_create_preroll_cta` | `POST accounts/:account_id/preroll_call_to_actions` |
| `x_update_preroll_cta` | Partial `PUT accounts/:account_id/preroll_call_to_actions/:id` |
| `x_delete_preroll_cta` | `DELETE accounts/:account_id/preroll_call_to_actions/:id` |

## Browse and edit

`x_preroll_ctas` takes `account_id`, optional `line_item_id`, `count` and native
`cursor`. Hosted calls include the selected `project_id`. Pages contain up to 50
settings and support **Load more**. Account-wide browsing does not fetch every
parent or edit context. An assistant can inspect a selected setting with
`x_get_preroll_cta` using its `preroll_call_to_action_id`.

The exact read, or a scoped gallery with complete context, exposes guarded
**Edit CTA** and **Remove CTA** actions in the existing widget. Unknown native
presets remain visible and are preserved during destination-only edits; the
widget does not silently select a known preset in their place. Incomplete or
contradictory edit context leaves settings visible without mutation controls.

To edit through an agent, read the exact CTA, then preview
`x_update_preroll_cta` with its `expected_context_hash`,
`acknowledge_ad_group_scope: true` and the supplied changes. Supported fields are
`call_to_action` and `call_to_action_url`. Review the changed values, parent
delivery and whole-ad-group scope, then apply identical arguments with the
returned `pending_operation_id` after approval.

Only actual changed fields are sent in the native PUT. Omitted fields are
preserved and independently checked. An unchanged request does not create a
pending mutation. The five native button presets are `GO_TO`, `SEE_MORE`, `SHOP`,
`VISIT_SITE` and `WATCH_NOW`; free-form button copy is not supported by this API.
Destinations must be HTTP(S) URLs without embedded credentials or controls.

## Create and remove

Creation starts with `x_preroll_cta_context`: supply `line_item_id`,
`call_to_action` and `call_to_action_url`. Use the returned `context_hash` as
`expected_context_hash` in `x_create_preroll_cta`, together with the identical
selection and `acknowledge_ad_group_scope: true`. Review and apply with the normal
pending token. Adport refuses native POST when active CTA settings already exist;
use an explicit update instead of an implicit replacement.

Creating a CTA requires existing non-draft `PREROLL_VIEWS` parents. Under
`paused_creation`, the ad group itself must currently be **PAUSED**. Adport does
not pause it silently. Existing budget pools are reported in micros for policy
caps. Editing existing CTA settings can affect active preroll ads; the preview
shows parent delivery, and the operation preserves parent status and budgets.

Removal uses the exact read's `expected_context_hash` and
`acknowledge_ad_group_scope: true` with `x_delete_preroll_cta`. It removes that
CTA configuration only, then verifies its native deleted tombstone and remaining
active CTA settings. **Removing a CTA does not pause ads** or delete media, ads,
other CTAs or the parent ad group.

## Consistency and limits

Approval hashes bind the exact CTA or creation selection, parent configuration
and complete active CTA inventory. Timestamps and optional account-scope echoes
do not cause hash changes. Inventory is bounded to ten advancing pages of at
most 200 settings; missing/repeated cursors, duplicate IDs, oversized pages and
scope contradictions prevent mutation.

Receipts and independent reads must match the approved button/destination,
preserved fields, parent configuration and expected remaining CTA records.
Unknown outcomes retain known IDs for reconciliation and are never retried
automatically. Provider errors do not establish absence. These reads are not
atomic locks, and the snapshot does not enumerate or freeze the ads that consume
the group setting. Native placement rendering and delivery remain separate from
configuration presence.

The official contract was refreshed on 2026-11-06 from the
[X Creatives reference](https://docs.x.com/x-ads-api/creatives/reference#preroll-call-to-actions),
with source pinned to
[xdevplatform/docs](https://github.com/xdevplatform/docs/blob/09e643bc80f16cfbbee3340db214e682daec4e97/x-ads-api/creatives/reference.mdx).
Wire/policy and synthetic MCP/OpenAI widget tests cover this implementation;
positive native mutations and actual Claude/ChatGPT execution remain unverified.

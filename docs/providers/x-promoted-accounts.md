# X promoted-account ads

These tools manage the native association between an existing X profile and an
ad group. The promoted account ID identifies that association; `user_id`
identifies the profile. Profile content stays live on X. This workflow does not
upload artwork, edit a profile or publish a post.

| Tool | Purpose |
| --- | --- |
| `x_promoted_accounts` | Page through one ad group's associations, profile links and removal actions. |
| `x_get_promoted_account` | Read one exact association, its parents and `context_hash`, including tombstones. |
| `x_promoted_account_context` | Review a profile, parent configuration and complete bounded existing inventory. |
| `x_create_promoted_account` | Preview/apply an association for the selected profile. |
| `x_delete_promoted_account` | Preview/apply removal of that one association. |

They are specialist creative tools in the same registry used by MCP, CLI and
Cloud REST. Hosted access still depends on the selected project, connection
profile and scopes. Capability discovery can explain a hidden tool without
executing it or changing access.

## Agent workflow

Find an existing `FOLLOWERS` ad group with product type `PROMOTED_ACCOUNT` using
`x_list_line_items`. Select a current `FULL` identity from `x_promotable_users`.
Call `x_promoted_account_context` with the selected account, ad group and user ID.
The context requires complete identity and association inventories; missing or
repeated continuation markers cannot establish absence.

Pass the returned hash as `expected_context_hash`, together with
`acknowledge_active_association: true` and `acknowledge_live_profile: true`, to
`x_create_promoted_account`. Review the result, then pass the identical arguments
and returned `pending_operation_id` to apply. Native creation has no independent
paused status. Under `paused_creation`, the ad group must currently be PAUSED,
even if the campaign is paused. Existing parent settings and budgets are retained
and their existing pools participate in the shared caps.

The hash binds profile identity, its FULL association, parent configuration and
the sorted live ad inventory. It does not snapshot live profile copy or artwork.
A selected identity change, revoked permission, changed parent or new association
requires a fresh context and preview. Existing live user associations are rejected
before submission. Native account/content eligibility is still decided by X;
the local preview is not server validation.

## Viewing and removal

The shared widget shows profile references and cursor-based **Load more**. It
does not invent profile imagery. Read-only grants hide removal actions. The
ordinary creative action obtains a new policy preview and a separate approval;
it cannot bypass project access or the pending-operation gate.

Read the exact association or use its gallery action to obtain removal context.
Deleting the association retains the profile, posts, other ads and parent
delivery/budgets. Native tombstones can still have `entity_status: ACTIVE`;
`deleted: true` establishes disassociation. This endpoint has no PUT operation,
so there is no standalone rename, copy edit or association-pause tool.

Single-resource POST uses the native `line_item_id` and `user_id` query fields.
DELETE targets the association ID. Both check native receipts and independently
read back the selected association and parents. Uncertain outcomes retain known
IDs, consume the original approval and are never replayed automatically.

## Verification boundary

Wire, policy, pagination and SDK/DOM tests use synthetic native responses. They
cover both widget bridges, access scopes, approvals and receipts. These checks
do not establish successful native writes or actual Claude/ChatGPT rendering.

Reference: [official X campaign-management API](https://docs.x.com/x-ads-api/campaign-management/reference),
checked against [provider-owned source at09e643bc](https://github.com/xdevplatform/docs/blob/09e643bc80f16cfbbee3340db214e682daec4e97/x-ads-api/campaign-management/reference.mdx).

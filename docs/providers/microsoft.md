# Microsoft Advertising workflows

Microsoft tools use the Campaign Management REST v13 API. The same definitions serve the CLI, local MCP and hosted MCP. Microsoft has no server-side dry-run for these operations: a preview reads native state and builds a client-side plan; the second identical call with `pending_operation_id` applies it through policy.

## Creatives and extensions

`microsoft_images` and `microsoft_get_library_image` read the selected account's library. `microsoft_upload_image` accepts checksum-bound PNG, JPEG or static GIF files up to 76,800 bytes. Cloud callers use private project `media_id`; local callers can use an absolute `file_path`. Uploading creates an unattached source image. Source media text is supplied at creation; source-image renaming is not exposed because a successful native update did not change it during verification.

`microsoft_image_extension_associations` reports native ImageAdExtension references only. It is not a complete responsive-ad usage inventory. `microsoft_delete_image` blocks known extension use; Microsoft also rejects deleting media that remains assigned. Accepted writes with unconfirmed readback report their resource IDs for reconciliation.

Named extension tools support Callout, Sitelink, StructuredSnippet and Image extensions. Create an unattached extension, inspect it, then associate it with an account, campaign or ad group through a separate approval. Under paused creation, new associations require an effectively paused campaign or ad group; account-wide associations are blocked. Native extensions have no independent pause setting.

Updates require `expected_version` from `microsoft_get_ad_extension`. Omitted mutable fields are preserved. Image extension `AlternativeText` edits are distinct from source media text. Changes affect every linked entity; previews show their associations. This is an optimistic check, not an atomic native version condition. Native widgets display explicit before/after values and use the same guarded tools to preview and apply edits.

## Targeting and exclusions

Campaign target tools handle age, gender, device, day/time, location, location intent and radius criteria. Bid multipliers are native percentage adjustments, such as `20` for +20%, rather than factors such as `1.2`. Microsoft requires all three device criteria to be added or removed together. Location intent cannot be deleted: restore its default through the named edit tool. Geographical location-file tools return download metadata and expiry; they do not install or infer location IDs.

`microsoft_negative_keywords` reads direct Campaign or AdGroup exclusions after verifying the full hierarchy. Add Exact or Phrase exclusions with `microsoft_add_negative_keywords`; remove exact owned IDs with `microsoft_remove_negative_keywords`. Text and match type are immutable, so add and confirm a replacement before removing its predecessor. Shared-list and inherited exclusions are separate. Exclusions have no individual serving status; removing them can broaden delivery.

## Shared daily budgets

`microsoft_shared_budgets` and `microsoft_get_shared_budget` return native pools, their campaign members, `membership_complete` and `snapshot_hash`. Discovery requests all eight campaign types; Microsoft's omitted-type default returns Search only. Writes require the discovered member count to match native `AssociationCount`.

`microsoft_campaign_budget` resolves an owned campaign's individual or shared daily limit. Shared pool `Amount` is authoritative; the campaign's replicated `DailyBudget` can lag. Its `snapshot_hash` binds campaign state and current pool membership.

1. Create an unattached `DailyBudgetStandard` pool with `microsoft_create_shared_budget`.
2. Read campaign context and destination pool. Pass their hashes as `expected_campaign_hash` and `expected_budget_hash` to `microsoft_assign_shared_budget`.
3. Rename or change the daily pool with `microsoft_update_shared_budget`, supplying `expected_snapshot_hash` from a fresh pool read. The preview identifies affected campaigns and checks the amount once for the pool, in currency micros.
4. Detach through `microsoft_unassign_shared_budget` with a fresh campaign hash and an explicit individual daily budget. The native request sends `BudgetId: "0"`, `DailyBudget` and `BudgetType: "DailyBudgetStandard"` together. Remaining pool amount and campaign status are preserved.
5. Delete an unused pool with `microsoft_delete_shared_budget`. Both native and discovered association counts must be zero; disappearance is verified.

Assignment compares the campaign's current effective daily limit with the destination pool amount for policy. Detachment creates an independent allocation alongside any remaining pool. These are per-resource checks, not an aggregate account-spend ceiling. Changing membership can redistribute spend among campaigns. Performance Max, Smart Shopping and experiment campaigns cannot be directly assigned or detached through these tools. Native compare-and-set is unavailable: snapshots reject changes discovered before submission, but cannot eliminate a concurrent native update.

Generic API writes reject shared-budget resources and references, so their monetary and membership checks cannot be bypassed. Native partial failures or uncertain readbacks must be reconciled before retrying; a returned resource ID is not permission to repeat a creation.

## Keyword planning

`microsoft_keyword_ideas` and `microsoft_keyword_historical_metrics` use Ad Insight's native `KeywordIdeas/Query` operation with expanding or nonexpanding seeds. Supply English, French or German, native location IDs, and a supported search network. Ideas accept keyword, HTTPS URL or known native category seeds; history requires keywords. The native category-catalog endpoint returned `UnsupportedEndpoint` as deprecated during live verification, so no typed category lookup is advertised.

Monthly counts remain native, newest-first, including strings and missing values. Supply an explicit `date_range` to identify the calendar period. Without it, the latest available month can lag by up to 72 hours. `returned_count` and `truncated` describe the actual returned collection; Microsoft currently caps it at 3,000 and supplies no continuation cursor. Missing metrics remain unavailable.

`microsoft_keyword_traffic_estimates` accepts hypothetical Phrase/Broad keywords, a default maximum CPC with optional keyword overrides, language/location/network criteria, and optional daily budget and exclusions. It returns native minimum/maximum estimates. Currency is reported when known. These requests create no resources and change no campaign settings; estimates are not observed results or performance guarantees.

## Coverage limits

These workflows do not represent the entire Microsoft API. Shared negative-keyword lists, additional extension formats, ad-group targeting, broader planning/recommendation APIs, conversion goals, offline conversions, audience management and experiments require their own implementations. Platform eligibility and the connection's native permissions still apply.

Contracts are checked against the official [Microsoft Advertising API documentation](https://learn.microsoft.com/en-us/advertising/guides/?view=bingads-13), including [Budget](https://learn.microsoft.com/en-us/advertising/campaign-management-service/budget?view=bingads-13), [Campaign](https://learn.microsoft.com/en-us/advertising/campaign-management-service/campaign?view=bingads-13) and [GetCampaignsByAccountId](https://learn.microsoft.com/en-us/advertising/campaign-management-service/getcampaignsbyaccountid?view=bingads-13).

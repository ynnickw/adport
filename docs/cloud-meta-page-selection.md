# Meta Page selection

After Meta OAuth, Adport displays ad accounts and Facebook Pages separately.
Pages start unchecked, including single-Page grants. Saving explicitly grants
the selected Pages to workspace Page tools; it does not associate a Page with
an ad account, publish content, activate campaigns, or enable ad accounts.

The OAuth callback discovers Pages with `me/accounts`. Sanitized ID, name and
category data is stored in the existing short-lived encrypted selection snapshot.
Saving accepts only IDs from that user/organization/authorization-bound snapshot,
updates `selectedPageIds` in the encrypted Meta credential in the same transaction
as account selection, and consumes the snapshot. Page tokens are never sent to
the browser. The audit event includes selected Page IDs.

The cloud runtime filters `meta_list_pages` and denies `meta_page_engagement`
outside this selection, even if Meta's grant is broader. Empty or missing Page
scope grants no Page access. Self-hosted provider behavior is unchanged.

## Rollout

No schema migration is required. Old array-shaped selection snapshots remain
readable. Existing cloud Meta connections must re-authorize and select Pages
to use Page tools; ad-account access is unchanged. Reauthorization resets Page
choices and requires explicit selection again. In Facebook, use **Edit settings**
to review which Pages and permissions the Meta grant itself includes.

The submission recording must show Facebook consent, this separate Page picker,
real Page reads and the paused-only campaign workflow. This picker does not
replace Meta's permission consent screen.

# Cloud account selection

Cloud OAuth authorization and adding accounts to Adport are separate steps for all providers.

Connect, Reconnect and Re-authorize open a centered 540 × 740 popup (clamped to available screen space) from both Connections and onboarding. The provider's real consent page remains a top-level window, not an iframe. Browsers may choose a tab instead. After the server validates consent and discovers accounts, the popup sends only a same-origin navigation destination to the initiating window and closes after acknowledgment. Account selection happens in the main window.

Popup delivery uses a random per-attempt BroadcastChannel identifier stored in the existing single-use OAuth transaction return path. It does not change provider callback URLs, OAuth state/PKCE validation, credentials, or database schema. The popup has no opener, and the existing `Cross-Origin-Opener-Policy: same-origin` remains enabled. Completion messages never contain OAuth codes, access tokens, or refresh tokens. Destinations are restricted to account selection, onboarding, and the two connection/account dashboard pages.

When popups or BroadcastChannel are unavailable, the ordinary link opens authorization in the same tab. While a popup is pending, a visible same-tab fallback remains available; the listener expires after ten minutes. If the main window was closed, the completion page provides a Continue button. Provider-denied consent and verification errors return through the same popup completion flow when a valid transaction can be identified.

1. The owner/admin authorizes the provider.
2. Adport discovers the accounts once and opens `/account-selection`.
3. With multiple accounts, the user selects accounts individually, selects all, or continues without any. With exactly one account, Adport shows its details without checkboxes or bulk-selection controls.
4. Saving replaces that provider's Adport inventory with only the selected accounts and deletes the discovery snapshot.
5. Unselected accounts cannot be listed, enabled, reported on, or mutated through the Cloud runtime. Re-authorizing is required to discover/select them again.

**Add and enable N accounts** explicitly imports the selection and enables assistant access in one transaction. The picker shows the available allowance across projects. **Import without enabling** adds new accounts as disabled and preserves access for existing enabled accounts. Older API clients that omit `enableAccess` retain this import-only behavior.

The server locks the shared organization allowance before saving, validates the selected IDs, and checks the resulting enabled count. A capacity failure rolls back inventory changes, Page choices, and snapshot consumption together. The user can choose fewer accounts or import without enabling. Provider consent may grant broader upstream access; the narrower selection is enforced by Adport, not represented as a provider-side permission revocation.

## Verified setup

Onboarding carries the chosen assistant from welcome to a compact connection panel. After account activation it moves directly to that panel. A successful, nonempty `accounts_list` or `report` call over the hosted MCP transport records verification on the credential. Authentication, discovery, dashboard reads, failed/partial reads and synthetic responses do not count. Verification remains attached to an OAuth grant through refresh rotation; expired or revoked grants do not count. Setup completion requires an enabled, connected account and a verified credential belonging to the signed-in user and selected assistant in this project. Client metadata identifies the assistant for UX only, never for authorization; API keys and unrecognized clients use **Other assistant**.

**Set up later** records `skipped_at`, independently of `completed_at`. Skipped projects keep a small setup checklist on Overview. Dismissal is stored per user/project in that browser; the permanent **Connect assistant** button remains available and opens the same connection panel in a modal. Its status refreshes while visible and when the user returns to the tab.

Official listing buttons are opt-in server configuration: `ADPORT_APPROVED_CHATGPT_LISTING_URL` and `ADPORT_APPROVED_CLAUDE_LISTING_URL`. Set each only after the Adport listing is approved and public. Destinations must use HTTPS on `chatgpt.com` or `claude.ai`, respectively. Empty or invalid configuration uses existing manual setup. No directory approval is implied and no public landing-page app links are introduced.

## Security and lifecycle

- Encrypted discovery snapshots live in a private, RLS-protected table, not public account inventory.
- A snapshot is bound to the initiating user, organization, connection and authorization generation. It expires after 30 minutes; expired data is purged every 10 minutes.
- Save rechecks session membership/role and validates submitted IDs against the snapshot. Clients cannot submit account metadata.
- Save is atomic and single-use. Concurrent saves serialize; reauthorization invalidates previous snapshots. Stale callback verification cannot update a newer connection generation.
- While account selection is pending, the provider is excluded from normal Cloud runtime access. No new account is automatically enabled.
- Ordinary MCP/REST account lists use saved inventory, not upstream discovery. Reads and writes retain the existing account-scope and two-step mutation guards.
- Existing inventory is preserved on migration. Re-authorize to review and remove previously imported accounts. Historical audit records remain subject to existing retention rules.
- The standalone picker also works before onboarding is complete and returns users to their original onboarding/dashboard path.

## Rollout

Apply `supabase/migrations/20260831152537_provider_account_selection.sql` before deploying the application changes. The migration adds a nullable column and a private snapshot table; it does not delete existing accounts or change existing enabled selections.

The migration must be deployed before the application. Re-authorize an existing connection to enter the new selection flow; deployment alone does not change saved accounts.

## Verification

- Workspace build, tests and typecheck passed.
- Cloud suite: 173 passing tests, including single-account confirmation for all 11 providers. Optional general database/HTTP suites were skipped; dedicated selection database tests were run separately against local Adport.
- Selection database suite: 9 passing tests for subset persistence, encryption, tenant/user/role restrictions, fabricated IDs, expiry, replay, reauthorization, selecting none, concurrent saves, and direct browser-role denial.
- Browser test: a newly created local user opened the picker before finishing onboarding, selected one of two fixture accounts, saved through the real API, and returned to onboarding with only the selected account. Database confirmed one saved account and zero remaining snapshots. Reopening the old picker returned the unavailable state without excluded account details.
- Local Supabase security advisor: no error-level issues.
- Temporary browser test user, organization and fixture script were removed after verification. No production accounts, credentials, campaigns, or billing settings were changed.

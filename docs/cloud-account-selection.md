# Cloud account selection

Cloud OAuth authorization and adding accounts to Adport are separate steps for all providers.

1. The owner/admin authorizes the provider.
2. Adport discovers the accounts once and opens `/account-selection`.
3. With multiple accounts, the user selects accounts individually, selects all, or continues without any. With exactly one account, Adport shows its details and an explicit **Add account** button, without checkboxes or bulk-selection controls.
4. Saving replaces that provider's Adport inventory with only the selected accounts and deletes the discovery snapshot.
5. Unselected accounts cannot be listed, enabled, reported on, or mutated through the Cloud runtime. Re-authorizing is required to discover/select them again.

Adding an account does not automatically enable agent access. New accounts are inactive; existing selected active accounts retain their setting. Existing active-account plan limits still apply when enabling accounts. Provider consent may grant broader upstream access; the narrower selection is enforced by Adport, not represented as a provider-side permission revocation.

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

# Synthetic reviewer workspace

This is an explicit, isolated review environment on the hosted Adport endpoint, not a replacement for production provider testing. Reviewers must be told that all sample metrics and campaigns are fictional. Never label these fixtures as actual Google/Meta/Snapchat data or platform-approved integrations.

## Administrative setup

1. Apply `20260906132858_synthetic_reviewer_workspace.sql` to the intended Supabase project, after inspecting the migration dry-run.
2. Link this checkout to that project using the intended Supabase CLI profile.
3. Build core, then run `node apps/cloud/scripts/provision-synthetic-reviewer.mjs <project-ref> <CLI-profile> <reviewer-email> <absolute-private-credential-file>`.
4. Add the returned organization UUID to the server-only `ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS` production environment variable and deploy. Do not add normal organizations.
5. Sign in using the private credential file, then authorize the real hosted MCP OAuth flow. No API key is needed.

The administrative script checks the linked project, rejects reuse of an existing account without its private recovery file, confirms the saved login, and refuses to repurpose an organization with provider connections. It saves a random password with mode 0600 outside the checkout. Provisioning grants a manual Premium entitlement without purchasing a subscription or touching Stripe. It never resets existing demo state on rerun.

## What reviewers can do

- `accounts_list`: two explicitly synthetic accounts (`demo-eur`, `demo-usd`).
- `report`: populated campaign/account reports, separate EUR/USD, selected metrics and date ranges (at most 366 days). Fictional historical performance remains unchanged when current budgets change.
- `demo_list_campaigns`: inspect four paused campaigns and current daily budgets.
- `demo_set_budget`: preview and apply an exact budget change using the normal policy gate and durable pending/audit stores. Supply the observed current budget as `expected_daily_budget_micros`.
- Recommendations/audit tools use the same synthetic reports and organization-scoped stores. Automated provider-specific recommendation application is not available for the demo provider.

All MCP results carry `data_source=synthetic`; embedded cards display **Synthetic demo**. No activation tool is registered. The server returns the synthetic runtime before loading real credentials, including during account discovery. Real provider OAuth is rejected for this organization. Missing provisioned state fails closed. Updates use compare-and-set to reject conflicting changes.

## Review evidence boundary

Capture fresh screenshots from the actual ChatGPT/Claude conversation after OAuth; deterministic HTML fixtures alone are not host execution evidence. Synthetic tests cover Adport UI, authentication and policy behavior, not the native APIs or review approvals of advertising platforms. Keep the reviewer password and portal-private login instructions out of this repository.

Before final submission, record production OAuth, report, exact apply, scope rejection, mismatched preview, refresh-token, and host-rendering outcomes in `validation-status.md`.

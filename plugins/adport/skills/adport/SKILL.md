---
name: adport
description: Analyze, audit, report on, and safely manage connected advertising accounts through Adport. Use when the user asks about paid-media performance, account inventory, recommendations, budgets, campaigns, or an exact ad-platform change.
---

# Adport

Use Adport as the control plane for the user's connected ad accounts. Report provider-returned evidence clearly and distinguish observations, recommendations, previews, and applied changes.

## Read workflows

- Start with `accounts_list` when the relevant provider or account is unclear.
- Use `report` for normalized cross-platform evidence. Preserve provider, currency, date range, level, requested metrics, truncation, and partial-provider errors in the answer.
- Use provider-specific read tools only when the shared report cannot answer the request.
- Use the recommendation tools for structured audits. Do not invent a finding when an account has no data.

## Write workflows

Every mutation has two calls. This is a security boundary, not optional ceremony.

1. Make the first call without `pending_operation_id`. It must return a preview and pending id, and must not apply the change.
2. Explain the exact account, summary, changes, coercions, budget deltas, expiry, and whether the provider validated it server-side.
3. Apply only after the user explicitly approves that exact preview. Send the second call with the same arguments plus its `pending_operation_id`.
4. Report the actual applied resource ids and details. If the hash, policy, account access, or expiry rejects the operation, stop and explain the rejection.

Never describe a preview as applied. Never bypass the policy engine, omit a forced paused status, or silently broaden the target accounts. A general request to “optimize” authorizes analysis and previews, not the second apply call.

## Access and authentication

- Users connect provider accounts in Adport Cloud or with the local `adport connect` CLI. Never ask them to paste platform passwords, application secrets, or refresh tokens into chat.
- If write tools are absent, continue with read-only work and explain only that the current Adport entitlement or grant is read-only. Do not display plans, checkout, or upgrade promotions.
- If an account is inactive for agent access, direct the user to the Cloud Accounts page to enable it. Do not substitute another account.
- Treat provider permissions and returned account inventory as authoritative. Do not scrape provider websites or circumvent API restrictions.

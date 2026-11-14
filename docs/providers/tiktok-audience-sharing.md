# TikTok audience sharing

These four typed tools share Adport's MCP, CLI and REST definitions. Sharing
grants another advertiser access to an audience; it is separate from uploading
customer records, creating an audience, attaching targeting or activating ads.

1. Read `tiktok_custom_audience_shares` with the source `account_id`, one to ten
   `custom_audience_ids` and one to ten explicit `shared_advertiser_ids`.
2. Call `tiktok_audience_sharing_context` with the same selection, `bc_id` and
   `action: "SHARE"` to inspect current authority, audiences and existing pairs.
3. Preview/apply `tiktok_share_custom_audiences` with those fields,
   `expected_context_hash` and `acknowledge_recipient_access: true`.
4. Inspect sharing logs and native audience status before using the audience.

For revocation, prepare a context with `action: "UNSHARE"` and exactly one
audience/recipient pair. Preview/apply `tiktok_unshare_custom_audience` with
singular `custom_audience_id` and `shared_advertiser_id`, `bc_id`,
`expected_context_hash` and `acknowledge_shared_effects: true`. Revocation can
affect ads targeting the shared audience. It retains the source audience,
customer records and other recipient pairs; it does not pause ads.

## Account and audience scope

Hosted calls require both the source and each destination account enabled in the
same selected project. Every affected account participates in protected-account
policy. Shared tool metadata derives those account IDs once, and binds them to
the pending operation, policy hash and sealed hosted approval. Native token-wide
access does not override project access. Changing a destination requires a new
preview and approval.

The current native OAuth grant must include each selected account. Adport checks
their membership in the explicit Business Center through the authorized user's
`bc/asset/get` advertiser view and requires ADMIN or OPERATOR on the source.
Membership is not a transfer of Business Center ownership. TikTok still checks
its own sharing eligibility and account relationships at apply. Exact selected
membership can be proven across native pages; an incomplete scan never proves
that a missing account is absent. Only selected account metadata is returned.

Only explicitly owned, available, non-expiring Customer File, Engagement, App
Activity, Website or Lookalike audiences are supported for new sharing. Native
`Website Audience` is the documented type for Website Traffic audiences.
Segment sharing is mentioned in the sharing overview, but its native detail-type
mapping is not established here. Other source families are rejected. Revocation
of an already shared owned audience can proceed when that source is unavailable
or expiring.

Reads preserve selected recipients' native statuses. Other recipient names and
IDs are omitted. Complete, explicit native `list` data is required; the published
empty-object example cannot establish an empty sharing log. No pagination
parameters are invented for this endpoint.

## Approval and receipts

Both mutations use the normal two-step policy and append-only audit gate. The
context checks source configuration, source authority, selected Business Center
accounts and current sharing pairs again at apply. It does not lock TikTok.
Already observed pairs are rejected rather than silently replayed. Partial
batches require reconciliation and a new explicit selection.

Native sharing returns `code: 0` with empty data, which is acceptance rather than
proof of every pair. Adport independently checks each requested pair in the
sharing log and reads back the source audience configuration. It also checks
that unrelated recipient IDs remain unchanged. On an uncertain or partial
outcome, errors retain known audience IDs and observed pair outcomes. No native
mutation is retried automatically. Sharing-log presence does not certify
matched membership, targetability or delivery. Revocation requires explicit
pair absence in a subsequent log read.

## Verification

Request/response tests follow the TikTok-owned
[SDK](https://github.com/tiktok/tiktok-business-api-sdk/tree/f809c396520df2d7b201a9ccc5378d822b728ed3)
and current published
[sharing](https://business-api.tiktok.com/portal/docs?id=1740245803888706),
[cancellation](https://business-api.tiktok.com/portal/docs?id=1740245829978113),
[sharing-log](https://business-api.tiktok.com/portal/docs?id=1740245827044354) and
[Business Center asset](https://business-api.tiktok.com/portal/docs?id=1739432717798401)
contracts checked on 2026-11-06. They assert JSON plural/singular fields, trailing
slashes, HTTP-200 error envelopes, exact IDs, scoped reads, stale contexts,
protected destinations, partial outcomes and independent readback.

SDK/DOM tests simulate both OpenAI and MCP widget bridges. These tests do not
prove successful native sharing/revocation or actual Claude/ChatGPT rendering.
No live audience access is changed merely by enabling these tools.

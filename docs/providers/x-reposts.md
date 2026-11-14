# X repost promotion

X's documented `RETWEETS_ONLY` workflow promotes another authorized user's
published post by creating a new nullcast repost and associating it with an ad
group. The returned `tweet_id` differs from the submitted original. Source post,
copied post and promoted-ad association IDs are separate identifiers.

## Review and create

1. Use `x_promotable_users` to find an existing RETWEETS_ONLY source author.
   Permissions must already be configured with X. These tools do not request
   permission, add authors or grant access.
2. Inspect originals with `x_published_posts` or `x_get_published_post` using
   that `user_id`. Native pagination supports Load more. Source posts remain
   read-only; this workflow cannot rename or replace someone else's content.
3. Call `x_repost_promotion_context` with the source `user_id`, target
   `line_item_id` and one to fifty unique original `tweet_ids`.
4. Preview/apply `x_create_repost_promotions` with the exact selection,
   `expected_context_hash`, `acknowledge_active_associations: true` and
   `acknowledge_new_published_copies: true`.

Both mutation calls use the shared policy, pending-token and append-only audit
gate. The context binds the complete selected originals, source/receiving
authors, current parent configuration and native association inventory. A
currently associated RETWEETS_ONLY source and an unambiguous FULL receiving
author are required. Native account/content eligibility remains authoritative;
there is no native server dry-run or conditional-write lock.

The review shows each original's copy, receiving author and parent statuses.
Created associations are native ACTIVE. Under `paused_creation`, the ad group
itself must be PAUSED; a paused campaign alone is insufficient. Existing money
pools participate in policy caps. No parent status or budget is changed.

## Mapping and partial outcomes

Adport submits one original per native `POST promoted_tweets` request, with at
most four requests in flight. It does not infer the source from array order or
match posts by similar text. Each successful result maps:

`source_tweet_id → copied_tweet_id → promoted_tweet_id`

The association receipt must identify a new copied-post ID, the correct ad group
and ACTIVE/non-deleted state. Adport independently reads the association, parent
configuration and copied published post under the receiving author, checking
promoted-only state. Parent/author/source configuration is checked again before
each native request. Mapping follows the documented single-source native
request; content and attachment rendering equivalence is explicitly unverified.
Inspect the copied posts before delivery.

Existing reposts use different IDs. The native association list does not provide
a verified original-source mapping for deduplication, so the acknowledgement
explicitly permits additional copies of previously promoted originals. A new
context/approval is required each time. Reusing an attempted approval is blocked.

On an error, no new requests start after the failure is observed. Already
in-flight requests finish so their receipts can be retained. The result records
confirmed source/copy/association mappings, reported IDs, ambiguous source IDs
and unconfirmed/unattempted sources. Conflicting duplicate receipts invalidate
every affected mapping, including an earlier apparently confirmed one. Reported
IDs alone do not establish successful creation or ownership. Reconcile before
preparing another selection. Widget Details and agent context retain an allowlisted
projection of these IDs and source states; arbitrary native payloads are omitted.
There is no automatic write retry or rollback.

Large batches can exceed host confirmation timeouts or hit native rate limits.
An absent response does not authorize retry. Inspect the account's current
associations and audit records before another preview.

## View and manage copies

Follow the returned `x_promoted_posts` arguments to view the copies with the
receiving FULL author. The gallery supports native paging and disassociation.
`x_delete_promoted_post` removes one ad association after its own preview and
approval; it retains originals, copied published posts and media. It is not
published-post deletion. Existing name-only edits use the account-scoped native
label route; creating a new post still requires composer authority.

Scheduled posts use the separate [scheduled workflow](x-scheduled-posts.md).
Ordinary FULL-author promotion uses the [published-post workflow](x-posts.md).

## Verification

Wire tests follow the provider-owned
[promotable-user and promotion reference](https://github.com/xdevplatform/docs/blob/570f918c5c2bdcdab8b6c5c838babc23962f30b9/x-ads-api/campaign-management/reference.mdx)
and [published-post reference](https://github.com/xdevplatform/docs/blob/a9226e1066661622a1e4f9528888927cb3d31c2a/x-ads-api/creatives/reference.mdx),
refreshed against current docs tree `09e643bc` on 2026-11-06. They assert signed
single-source queries, author/parent checks, one to 50 selected sources, bounded concurrency,
stale/duplicate/partial responses and shared policy enforcement.

SDK/DOM bridge tests use simulated native data. They do not prove positive native
repost promotion, actual source-rendering equivalence, or real Claude/ChatGPT
execution. Other promoted product formats and normalized conversion reporting
remain separate work.

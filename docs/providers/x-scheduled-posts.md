# X scheduled posts and ad associations

Scheduled content uses the same shared definitions in MCP, REST and CLI. All
five mutation tools require a policy preview, followed by the identical arguments
and `pending_operation_id` to apply. Previews do not validate content with X.
Scheduling does not pause a post: X publishes it automatically at the requested
time. Adport supports promoted-only (`nullcast=true`) scheduling; organic
creation and conversion from drafts are outside this workflow.

## Schedule, inspect and edit

1. Call `x_scheduled_posts` with an explicit account-associated `user_id`.
   Native `cursor` pagination supports Load more. Copy, schedule time, native
   status and the eventual published `tweet_id` remain distinct. Media previews
   use only the selected account's library and allowed native CDN URLs.
2. Prepare `x_scheduled_post_context` with a FULL `as_user_id`, text or native
   media keys, optional card/name and `scheduled_at`.
3. Preview/apply `x_create_scheduled_post` with that exact request,
   `expected_context_hash` and `acknowledge_automatic_publication: true`.
4. Read `x_get_scheduled_post` for `snapshot_hash` before editing or deletion.

Use an explicit UTC minute, for example `2026-12-08T12:34:00Z`. X ignores
seconds, so Adport rejects sub-minute input. New or edited schedules must be at
least 15 minutes and no more than one calendar year ahead. The minimum is an
Adport review/readback margin; the one-year maximum is X's documented limit.
Composer permission, account-associated FULL authors and ready library sources
are checked again at apply. The context hash binds the exact request and source
configuration; it is not a provider lock.

`x_update_scheduled_post` changes supplied text, name, time, media or card fields.
It requires `expected_snapshot_hash` and the automatic-publication
acknowledgement. Omitted fields remain unchanged. `media_keys: []` clears media;
`card_uri: null` clears the card using an empty native query parameter. Text or
media must remain. Native receipts and independent GETs must preserve the
expected configuration. URL rewriting or other unconfirmed content is not
silently certified as applied.

The snapshot includes complete current scheduled-ad associations. Editing a
shared schedule requires `acknowledge_shared_effects: true`; the review shows
affected association/ad-group IDs. Adport refuses preparation when it cannot
establish a complete association inventory within ten native pages. List views
remain usable with native pagination. Preview hydration uses at most forty
unique media-library reads per page with four concurrent requests; copy is
retained when previews are unavailable. Use `include_media: false` for a lighter
agent inventory. Card rendering is not independently certified.

`x_delete_scheduled_post` permanently cancels a still-future, unpublished,
promoted-only schedule. It requires the current snapshot and
`acknowledge_permanent_deletion: true`. Remove its live scheduled ad associations
first. X hard-deletes schedules: Adport checks the exact DELETED receipt and an
independent HTTP 404, without treating authorization errors as absence. It does
not delete already published posts or reusable media.

## Scheduled ads

1. Read `x_scheduled_promotion_context` with `user_id`, `scheduled_tweet_id`
   and `line_item_id`. It checks the unpublished future source, current supported
   parents, money configuration and existing associations.
2. Preview/apply `x_create_scheduled_promoted_post` using
   `expected_context_hash` and `acknowledge_automatic_promotion: true`.
3. Inspect `x_scheduled_promoted_posts` or the exact
   `x_get_scheduled_promoted_post`.
4. Before the publication time, preview/apply
   `x_delete_scheduled_promoted_post` with its association ID
   (`scheduled_promoted_tweet_id`) and current `expected_context_hash` to remove
   only that ad association. The source schedule still publishes automatically.

The native POST accepts one singular `scheduled_tweet_id` and returns an object.
There is no association status field or PUT pause. With `paused_creation`
enabled, Adport requires the ad group itself to be PAUSED. A paused campaign
alone does not satisfy that rule. Current monetary pools still participate in
shared policy caps; no parent status or budget is changed. Publication can make
the association eligible for delivery when its parents permit it.

The schedule ID, scheduled-ad association ID and eventual published `tweet_id`
are different identifiers. After publication, inspect the ordinary
[promoted-post associations](x-posts.md) for removal; do not assume a scheduled
association ID is an ordinary promoted-post ID. Native objective/content/account
eligibility remains authoritative.

## Verification and boundaries

Wire and policy tests follow the provider-owned
[creative reference](https://github.com/xdevplatform/docs/blob/a9226e1066661622a1e4f9528888927cb3d31c2a/x-ads-api/creatives/reference.mdx),
[campaign reference](https://github.com/xdevplatform/docs/blob/570f918c5c2bdcdab8b6c5c838babc23962f30b9/x-ads-api/campaign-management/reference.mdx)
and [Python SDK](https://github.com/xdevplatform/twitter-python-ads-sdk/blob/a3dd5819341e77aa469d0b4b3399f0bcd028c80c/twitter_ads/creative.py),
checked on 2026-11-06. They assert signed query formats, receipt/readback shapes,
owner/parent checks, shared-effects approval and uncertain-outcome handling.
Known IDs survive malformed or partial native responses. No write is retried.

SDK/DOM tests simulate OpenAI and MCP host bridges. They do not prove actual
Claude/ChatGPT rendering or successful native scheduling writes. This addition
does not complete RETWEETS_ONLY copying, other promoted product formats or
normalized conversion/value reporting.

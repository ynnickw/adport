# X published posts and ad associations

Adport uses the same typed definitions in MCP, REST and CLI. Every mutation
requires a policy preview and a second call with identical arguments plus the
returned `pending_operation_id`. X does not provide a server dry-run for these
operations. A source hash checks configuration again at apply; it does not lock
the provider against concurrent changes.

## Publish a promoted-only creative

1. Use `x_published_posts` or `x_get_published_post` to inspect existing content
   for an explicit account-associated `user_id`. IDs remain exact strings.
2. For new content, call `x_post_creation_context` with the intended author,
   copy, optional name, media/card and reply settings. It verifies a current FULL
   promotable author, composer authority and ready account-owned sources.
3. Preview/apply `x_create_promoted_only_post` with those fields,
   `expected_context_hash` and `confirm_publication: true`.
4. Inspect the returned published post before preparing ad associations.

Creation uses native `POST accounts/:account_id/tweet` with `nullcast=true`.
The result is a distinct published post, available for advertising. It does not
appear in the public timeline or serve to followers through that nullcast
workflow. It is not an unpublished draft. Existing draft IDs remain unchanged;
no native draft-to-published transition is invented. Organic publication and
scheduled posts are separate workflows.

Image/GIF/video inputs refer to existing ready account-library media, which can
be uploaded from Adport project files using `x_upload_media` and
`x_register_uploaded_media`. New publication never replays or reconciles an
earlier uncertain upload. Video metadata requires a video attachment.

The native creation receipt omits some publication settings, so Adport reads the
exact resulting post independently to check its author, promoted-only state,
reply setting and supplied name. Native URL rewriting can change displayed
text. The result explicitly reports whether the submitted text was observed
exactly; it does not certify equivalence when the strings differ. Referenced
source ownership/readiness is checked, while the published attachment rendering
is not independently certified. Inspect the actual published media/copy before
promotion. Accepted IDs are retained if receipt/readback is uncertain; never
repeat creation automatically.

`x_rename_published_post` uses the native name-only PUT route with
`expected_snapshot_hash`. It verifies preservation of the returned post
configuration. The gallery's menu offers this name edit for FULL authors.
Published copy/media replacement uses another post; the name route cannot edit
that content.

## Associate and remove ads

1. Select a supported non-draft campaign/ad group and call
   `x_promotion_context` with `line_item_id`, a FULL `user_id` and one to fifty
   existing published `tweet_ids`.
2. Inspect exact copy, parent settings and existing matching associations.
   Already associated posts are rejected to prevent accidental repeated creates.
3. Preview/apply `x_create_promoted_posts` with `expected_context_hash` and
   `acknowledge_active_associations: true`.
4. Use `x_promoted_posts` for the gallery or `x_get_promoted_post` for the exact
   association and its current context hash.

X creates associations with native `entity_status=ACTIVE` and has no PUT status
endpoint for them. With `paused_creation` enabled, Adport requires the ad group
itself to be PAUSED. A paused campaign with an ACTIVE ad group does not satisfy
this rule. The review shows both parent statuses and native association state;
creation changes no parent status or budget. Existing monetary pools participate
in policy checks. With paused creation disabled, an ACTIVE association can begin
serving when its parents permit delivery. Native objective/content/account
eligibility remains authoritative.

`x_delete_promoted_post` takes the **association ID** (`promoted_tweet_id`),
not the published post's `tweet_id`, plus `expected_context_hash`. Native DELETE
disassociates the one ad. The response and independent tombstone read must have
`deleted=true`; native status can still be ACTIVE on that tombstone. X presents
this as paused in its own UI. Adport labels the gallery item DISASSOCIATED and
retains the published post, media and other associations. Re-promotion needs a
new context and approval. This is not published-post deletion.

Both galleries support native cursor continuation through **Load more** and the
shared widget's stable cards/players. Optional `user_id` on the association
gallery hydrates the selected author's content; failed/partial hydration keeps
the native references visible with a warning. Association removal is available
through the existing menu, preview and approval flow. Native parent settings
and ACTIVE association state do not prove actual delivery.

RETWEETS_ONLY promotion creates a different native nullcast post ID, so its
source-to-receipt workflow remains separate. The tools do not silently assume
those returned IDs equal the original post IDs. Scheduled associations and
promoted-account/media-creative authoring are also separate native families.

## Verification

Wire and policy tests use the current provider-owned
[creative reference](https://github.com/xdevplatform/docs/blob/a9226e1066661622a1e4f9528888927cb3d31c2a/x-ads-api/creatives/reference.mdx)
and [campaign reference](https://github.com/xdevplatform/docs/blob/570f918c5c2bdcdab8b6c5c838babc23962f30b9/x-ads-api/campaign-management/reference.mdx),
checked on 2026-11-06. They cover signed query parameters, native receipt shapes,
account/author/parent checks, complete targeted reads, changed sources, policy
caps, partial IDs and consume-once approval. SDK/DOM bridge tests are synthetic;
they are not actual Claude or ChatGPT browser verification. Native publication
and association mutations require their own authorized verification and are not
claimed from these tests.

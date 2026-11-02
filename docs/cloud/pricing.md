# Cloud pricing and Stripe catalog

The shared public catalog is `apps/cloud/lib/cloud/plan-catalog.json`. Both the dashboard and generated marketing prices use it. Run `node scripts/website/build-pricing-page.mjs` after changing it; CI checks the generated landing section and `/pricing` page for drift.

| Public plan | Stable internal ID | Monthly EUR | Annual EUR | Active accounts | Editing members | Audit days |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Free | reader | 0 | 0 | 3 | 1 | 30 |
| Pro | operator | 19 | 190 | 5 | 2 | 90 |
| Growth | premium | 39 | 390 | 20 | 5 | 365 |
| Business | agency | 79 | 790 | 60 | 15 | 730 |

Allowances are shared per organization, across unlimited projects. Read-only viewers do not consume editing seats. Owners and admins count; a member editing multiple projects consumes one seat. A project-level editor cannot hide behind an organization viewer role. Database triggers and authenticated handlers enforce promotions and concurrent invitations. Existing read-only access is retained after a downgrade; write scopes are limited to the plan's editing seats, ordered by owner/admin/member, membership age, then user ID. Owners retain organization/billing rights even when their ad access is read-only. Organization settings lets owners choose which people remain editors by changing others to Viewer.

The Business plan retains the stable `agency` ID and existing Stripe price IDs. This is a display-name change; prices, allowances, subscriptions, and historical mappings are unchanged.

## Stripe

Current checkout requires these server variables:

- Pro: `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`
- Growth: `STRIPE_GROWTH_PRICE_ID`, `STRIPE_GROWTH_ANNUAL_PRICE_ID`
- Business: `STRIPE_AGENCY_V2_PRICE_ID`, `STRIPE_AGENCY_V2_ANNUAL_PRICE_ID`
- Portal: `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`

The original Operator/Premium/Agency variables remain webhook-only legacy mappings. `STRIPE_LEGACY_PRICE_PLAN_MAP` is a JSON object mapping additional historical price IDs to stable plan IDs. An old price is never offered as a fallback for new checkout: missing current configuration disables the corresponding CTA, preventing a €39 card from silently charging an old €79 price.

The live/test product and recurring-price pairs were created with the Stripe CLI in the verified Adport account and catalog metadata `catalog_version=2026-10-31`. Live prices are EUR 1900/3900/7900 cents monthly and 19000/39000/79000 cents yearly. Existing products, prices, and subscriptions are retained. Only a customer's explicit plan change changes an existing subscription's price. Each Checkout uses quantity one, organization metadata, and the signed subscription webhook for entitlement changes. The first subscription receives a seven-day trial. A canceled customer can subscribe again using the same billing customer without a second trial.

The live portal permits price changes among the six current prices; quantity changes are excluded. Upgrades invoice prorated differences immediately. Price decreases and changes to a shorter billing interval are scheduled for the end of the paid period. Cancellation takes effect at period end, and invoice history and payment-method updates are available. Keep these settings aligned in test and live mode. The CLI profile named `adport` is not a reliable identity check: verify the Stripe account ID before changing configuration.

## Subscription lifecycle

Apply `20261101122925_billing_lifecycle_consistency.sql` before deploying billing lifecycle code. It adds cancellation metadata and reconciliation timestamps, and a backend-only table for durable Checkout attempts. Anonymous and authenticated clients have no access to that private table. Keep this additive schema when rolling back application code.

Signed subscription events are notifications to fetch current Stripe state, rather than authoritative snapshots. The organization billing lock serializes this fetch and the entitlement update. The event-ID claim, account downscaling, retention adjustment, and audit entry commit in one transaction. A processing failure returns HTTP 500 and rolls back the claim for a Stripe retry. Signature errors return HTTP 400. The webhook listens for created, updated, deleted, paused, and resumed subscription events.

Active, trialing, and past-due subscriptions retain paid access. Unpaid, incomplete, expired, paused, and canceled subscriptions have Free access. Paused and expired statuses are retained accurately instead of being represented as voluntary cancellations. Scheduled cancellations retain paid access and show the end date in Plan & billing. Payment failures show recovery guidance. A cancellation does not pause campaigns or delete the provider connections.

An explicit manual paid grant with its Stripe binding removed is preserved when old customer events arrive. Starting a new Checkout reserves a billing customer before it can emit subscription events. An incomplete or failed payment does not remove an existing manual grant; an active or trialing subscription from that checkout can replace it with the selected plan.

Checkout verifies ownership of the billing organization and checks Stripe for an existing subscription, even before its webhook arrives. It commits a stable attempt and exact parameters before creating a session, then uses that attempt ID as the Stripe idempotency key. Concurrent requests reuse the same open session. A new plan selection expires the preceding unpaid session; completed payments cannot be expired or replaced. Old sessions predating this table are also expired before a replacement is offered. Customers with an ended subscription can subscribe again without another trial.

Set a random production `CRON_SECRET` of at least 32 characters. Vercel calls `/api/billing/reconcile` hourly at minute 17 using that bearer secret. The endpoint checks up to 50 Stripe-backed billing organizations, oldest reconciliation attempt first, within a bounded run. Failed customers rotate too, so one invalid customer cannot prevent other organizations from being checked. It compares current Stripe state and writes an audit entry only when subscription details actually change. Manual test/beta plans without a Stripe subscription are excluded. Nonzero `failed` counts return HTTP 500 for monitoring; do not interpret a failed Stripe lookup as cancellation or revoke access on that basis.

Before promoting a release, run the lifecycle database tests against local Supabase and simulated Stripe, check schema advisors and TypeScript, then verify the live reconciliation endpoint and the customer's effective access. Never complete a live checkout or cancel a real subscription to test these paths.

## Release and rollback

Apply the organization/project and consent dependencies, followed by `20261031161752_cloud_competitive_pricing_and_viewer_seats.sql`, before deploying this cloud code. The pricing migration adds no public API grants. It keeps plan IDs and existing tenant IDs intact. The capacity-count function is VOLATILE so quota triggers see changes made by the current statement.

Current-price variables are separate from the original variables, so preparing them does not alter checkout in an older deployment. Keep the legacy map during future catalog changes. Do not rewrite subscription items or delete old products to publish a new catalog. Verify the new values by retrieving the Stripe prices, not by trusting their names.

To roll back the public offer, deploy the preceding pricing code/catalog and keep all historical webhook mappings. Do not blindly roll back organization migrations or remove IDs used by existing subscriptions. Keep current portal switching disabled until the rollback's price mappings are verified.

Local validation uses isolated Supabase, Stripe test-mode prices and Stripe CLI webhook forwarding. The test completed a Growth checkout, verified the signed subscription webhook, and verified read/write seat boundaries without modifying advertising accounts. Never complete a live checkout as a payment test.

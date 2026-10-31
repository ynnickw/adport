# Cloud pricing and Stripe catalog

The shared public catalog is `apps/cloud/lib/cloud/plan-catalog.json`. Both the dashboard and generated marketing prices use it. Run `node scripts/build-pricing-page.mjs` after changing it; CI checks the generated landing section and `/pricing` page for drift.

| Public plan | Stable internal ID | Monthly EUR | Annual EUR | Active accounts | Editing members | Audit days |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Free | reader | 0 | 0 | 3 | 1 | 30 |
| Pro | operator | 19 | 190 | 5 | 2 | 90 |
| Growth | premium | 39 | 390 | 20 | 5 | 365 |
| Agency | agency | 79 | 790 | 60 | 15 | 730 |

Allowances are shared per organization, across unlimited projects. Read-only client viewers do not consume editing seats. Owners and admins count; a member editing multiple projects consumes one seat. A project-level editor cannot hide behind an organization viewer role. Database triggers and authenticated handlers enforce promotions and concurrent invitations. Existing read-only access is retained after a downgrade; write scopes are limited to the plan's editing seats, ordered by owner/admin/member, membership age, then user ID. Owners retain organization/billing rights even when their ad access is read-only. Organization settings lets owners choose which people remain editors by changing others to Viewer.

## Stripe

Current checkout requires these server variables:

- Pro: `STRIPE_PRO_PRICE_ID`, `STRIPE_PRO_ANNUAL_PRICE_ID`
- Growth: `STRIPE_GROWTH_PRICE_ID`, `STRIPE_GROWTH_ANNUAL_PRICE_ID`
- Agency: `STRIPE_AGENCY_V2_PRICE_ID`, `STRIPE_AGENCY_V2_ANNUAL_PRICE_ID`
- Portal: `STRIPE_BILLING_PORTAL_CONFIGURATION_ID`

The original Operator/Premium/Agency variables remain webhook-only legacy mappings. `STRIPE_LEGACY_PRICE_PLAN_MAP` is a JSON object mapping additional historical price IDs to stable plan IDs. An old price is never offered as a fallback for new checkout: missing current configuration disables the corresponding CTA, preventing a €39 card from silently charging an old €79 price.

The live/test product and recurring-price pairs were created with the Stripe CLI using the dedicated `adport` profile and catalog metadata `catalog_version=2026-10-31`. Live prices are EUR 1900/3900/7900 cents monthly and 19000/39000/79000 cents yearly. Existing products, prices, and subscriptions are retained. Only a customer's explicit plan change changes an existing subscription's price. Each Checkout uses quantity one, a seven-day trial, organization metadata, and the signed subscription webhook for entitlement changes.

The new live portal configuration is prepared with subscription switching disabled until the matching cloud release is ready. After deploying and verifying the new price mappings, enable `features[subscription_update][enabled]=true` on that configuration. Its permitted updates are price changes among the six new prices, with cancellation at period end; quantity changes are excluded.

## Release and rollback

Apply the organization/project and consent dependencies, followed by `20261031161752_cloud_competitive_pricing_and_viewer_seats.sql`, before deploying this cloud code. The pricing migration adds no public API grants. It keeps plan IDs and existing tenant IDs intact. The capacity-count function is VOLATILE so quota triggers see changes made by the current statement.

Current-price variables are separate from the original variables, so preparing them does not alter checkout in an older deployment. Keep the legacy map during future catalog changes. Do not rewrite subscription items or delete old products to publish a new catalog. Verify the new values by retrieving the Stripe prices, not by trusting their names.

To roll back the public offer, deploy the preceding pricing code/catalog and keep all historical webhook mappings. Do not blindly roll back organization migrations or remove IDs used by existing subscriptions. Keep current portal switching disabled until the rollback's price mappings are verified.

Local validation uses isolated Supabase, Stripe test-mode prices and Stripe CLI webhook forwarding. The test completed a Growth checkout, verified the signed subscription webhook, and verified read/write seat boundaries without modifying advertising accounts. Never complete a live checkout as a payment test.

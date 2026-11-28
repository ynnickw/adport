# Provider brand assets

Cloud provider badges share `apps/cloud/components/logos.tsx`, including
Connections, onboarding, account tables, reports and policies. Keep brand colors
on the artwork rather than inheriting surrounding text color.

- Snapchat: official two-tone Ghost SVG served by [Snapchat for Business](https://forbusiness.snapchat.com)
  at [its asset URL](https://s3.amazonaws.com/bitmoji-sdk-images/logo-snapchat.svg).
  Its two path geometries and black/white fills are preserved in
  `snapchat-logo.tsx`; the badge uses Snapchat yellow. No external image request
  is made at runtime. [Ghost guidelines](https://help.snapchat.com/hc/en-us/articles/7012349890452-Snapchat-Ghost-Logo-Usage-Guidelines).
  The landing page and generated provider pages reuse the same unmodified Ghost
  paths with an explicit yellow (#FFFC00) background and clear space inside the
  SVG, so the full-color badge does not depend on surrounding CSS.
  The embedded MCP card in `packages/mcp/src/ui.ts` also includes these exact
  paths; a regression test checks parity with the cloud component.
- Spotify: Simple Icons geometry, Spotify green (#1ED760).
  [Branding reference](https://developer.spotify.com/documentation/design).
- Pinterest: Simple Icons geometry, Pinterest red (#E60023).
  [Branding reference](https://business.pinterest.com/en-us/brand-guidelines/).
- LinkedIn: Font Awesome LinkedIn mark, LinkedIn blue (#0A66C2).
- OpenAI: monochrome knot mark (Remix Icon, black on white in Cloud; Simple Icons, white on black in MCP).
- Gravity: official solid symbol from the [Gravity brand page](https://trygravity.com/brand), used in the dashboard and MCP cards.
- Matomo: Simple Icons geometry, Matomo blue (#3152A0), used in the dashboard and MCP cards.
  [Brand assets](https://matomo.org/media/).
- X and Apple remain black because their marks are monochrome.
- The existing Google, Meta, TikTok, Microsoft and Reddit brand colors remain.

Provider marks belong to their respective owners. Their use identifies a
connection provider, not a partnership or endorsement.

The public resource pages serve the following vendor artwork locally from `website/media/brands/`.

| Product | Asset source |
| --- | --- |
| Matomo | [Matomo’s current site icon](https://matomo.org/wp-content/uploads/2026/04/favicon-matomo-2026-150x150.png), as used on its press page |
| Gravity | [Black solid symbol](https://www.trygravity.com/brand/gravity-symbol-solid-black.svg) for small placements |
| DuckDuckGo | Dax Solo from the [DuckDuckGo press kit](https://staticcdn.duckduckgo.com/press/DuckDuckGo-Brand-Logo.zip) |
| Google Analytics and Search Console | Google’s [Analytics](https://www.gstatic.com/images/branding/product/2x/analytics_64dp.png) and [Search Console](https://www.gstatic.com/images/branding/product/2x/search_console_64dp.png) product icons |

# Provider brand assets

Cloud provider badges share `apps/cloud/components/logos.tsx`, including
Connections, onboarding, account tables, reports and policies. Keep brand colors
on the artwork rather than inheriting surrounding text color.

- Snapchat: official two-tone Ghost SVG served by [Snapchat for Business](https://forbusiness.snapchat.com)
  at [its asset URL](https://s3.amazonaws.com/bitmoji-sdk-images/logo-snapchat.svg).
  Its two path geometries and black/white fills are preserved in
  `snapchat-logo.tsx`; the badge uses Snapchat yellow. No external image request
  is made at runtime. [Ghost guidelines](https://help.snapchat.com/hc/en-us/articles/7012349890452-Snapchat-Ghost-Logo-Usage-Guidelines).
- Spotify: Simple Icons geometry, Spotify green (#1ED760).
  [Branding reference](https://developer.spotify.com/documentation/design).
- Pinterest: Simple Icons geometry, Pinterest red (#E60023).
  [Branding reference](https://business.pinterest.com/en-us/brand-guidelines/).
- LinkedIn: Font Awesome LinkedIn mark, LinkedIn blue (#0A66C2).
- X and Apple remain black because their marks are monochrome.
- The existing Google, Meta, TikTok, Microsoft and Reddit brand colors remain.

Provider marks belong to their respective owners. Their use identifies a
connection provider, not a partnership or endorsement.

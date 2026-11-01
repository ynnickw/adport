# Resources content and dashboard UI

The Resources hub, five topic hubs, twenty-two articles, and landing section are generated from `scripts/website-resources.mjs` and `scripts/resource-content/`. The articles contain original operating guidance, with provider documentation linked beside platform-specific claims and listed at the end.

| Cluster | Search intent | Initial articles |
| --- | --- | --- |
| Connect ads to Claude | Set up Claude or Claude Code for a specific ad provider | Shared MCP setup; Google; Meta; TikTok; Snapchat; LinkedIn; Microsoft |
| Connect ads to ChatGPT | Install a ChatGPT MCP plugin and review a specific provider | Shared plugin/OAuth setup; Google; Meta; TikTok; Snapchat; LinkedIn; Microsoft |
| AI ad management | Connect an AI client to real Google Ads data | Google Ads MCP server; Claude; ChatGPT; Codex |
| Google Ads optimization | Investigate a concrete account issue | Audit checklist; negative keywords; budget pacing |
| Agency operations | Organize clients, permissions, and reporting | Multi-client management; client viewers; CPA vs ROAS |

These are intent-led priorities. Ahrefs keyword-metric requests returned `Insufficient plan` in both available connections, so no volume, difficulty, traffic forecast, or ranking claims were used. Review Search Console data after publication to choose subsequent articles. Publication and sitemap inclusion do not establish indexing or traffic gains.

The ChatGPT cluster targets connection and reporting intent, rather than buying ad placements inside ChatGPT. The shared setup guide covers plugin installation, project-scoped OAuth, selection in a conversation, and connection troubleshooting. Provider articles add their own reporting questions, measurement context, and verification workflow; they are not Claude articles with the assistant name replaced.

Keep one URL for each provider/client intent. Facebook and Instagram variants belong on the Meta guide; Microsoft and Bing belong on the Microsoft guide. The existing `/resources/google-ads-with-chatgpt` URL stays canonical and appears in both the ChatGPT hub and AI ad management hub. `relatedClusters` supports that cross-listing without publishing a second article. Each substantive guide has its own canonical URL, original metadata, Article data, internal links, and a sitemap entry.

Google's [spam policies](https://developers.google.com/search/docs/essentials/spam-policies) address substantially similar doorway pages and scaled, low-value content. The purpose of this cluster is to complete a different client setup and a provider-specific investigation. Shared navigation and setup facts do not replace useful article content. After publication, inspect queries and landing pages together for overlapping intent before adding more variants.

Article setup instructions were checked against current official OpenAI and Anthropic documentation. Google negative matching was checked against the current source: casing and misspellings are covered automatically, while singular/plural and synonyms need separate consideration. Worked performance figures are explicitly illustrative. Articles preserve currencies, distinguish attribution from business outcomes, and never present ratios averaged across campaigns as account totals.

Run these after editing shared navigation, catalogs, or content:

```sh
node scripts/build-resource-pages.mjs
node scripts/build-pricing-page.mjs
node scripts/build-provider-pages.mjs
node scripts/build-support-widget.mjs
```

Each generator has `--check`; CI also checks resource metadata, structured data, source references, local assets, fragments, and discovery through hubs and the sitemap. Resource sitemap entries are inserted before provider entries so the generators remain stable in any normal verification order. Canonical URLs use `https://www.adport.dev` and Vercel clean URLs.

The public support widget is shared through `scripts/website-support.mjs`. All page generators apply it, and `build-support-widget.mjs` updates the static pages and copies the existing Cloud portrait. The public form uses a same-origin `/api/support` rewrite to Cloud's `/api/public-support`, which validates requests, rate-limits through the existing private bucket helper, and sends to the configured support inbox. The authenticated dashboard support route remains separate.

Existing brand assets are reused directly from the homepage: Google Ads, Meta, Claude, ChatGPT, and MCP marks. No invented customer performance, testimonials, stock dashboard screenshots, or traffic statistics are used.

Dashboard controls live in `components/controls.tsx`, `select.tsx`, `dialog.tsx`, `info-tooltip.tsx`, and `use-confirm.tsx`. Selects support keyboard navigation and form resets. Native dialog top-layer behavior supplies focus containment; custom popups portal inside the current dialog so they remain visible. Important errors, destructive-action context, and retired-workspace instructions stay visible. Routine help moves to tooltips.

The navigation groups account connections and approval history into their related sections. Project and organization forms use compact lists and editing dialogs. Team-page project renaming was removed because Projects already supplies it. Provider reads, project permissions, and the advertising write gate retain their existing server contracts. Dashboard performance consumes the existing registry's currency-separated summary, including null/unavailable metrics and weighted ROAS; no new metric engine or tool definition was added.

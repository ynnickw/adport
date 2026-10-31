# Resources content and dashboard UI

The Resources hub, three topic hubs, ten articles, and landing section are generated from `scripts/website-resources.mjs` and `scripts/resource-content/`. The articles contain about 7,200 words of original operating guidance, with provider documentation linked beside platform-specific claims and listed at the end.

| Cluster | Search intent | Initial articles |
| --- | --- | --- |
| AI ad management | Connect an AI client to real Google Ads data | Google Ads MCP server; Claude; ChatGPT; Codex |
| Google Ads optimization | Investigate a concrete account issue | Audit checklist; negative keywords; budget pacing |
| Agency operations | Organize clients, permissions, and reporting | Multi-client management; client viewers; CPA vs ROAS |

These are intent-led priorities. Ahrefs keyword-metric requests returned `Insufficient plan` in both available connections, so no volume, difficulty, traffic forecast, or ranking claims were used. Review Search Console data after publication to choose subsequent articles. Publication and sitemap inclusion do not establish indexing or traffic gains.

Article setup instructions were checked against current official OpenAI and Anthropic documentation. Google negative matching was checked against the current source: casing and misspellings are covered automatically, while singular/plural and synonyms need separate consideration. Worked performance figures are explicitly illustrative. Articles preserve currencies, distinguish attribution from business outcomes, and never present ratios averaged across campaigns as account totals.

Run these after editing shared navigation, catalogs, or content:

```sh
node scripts/build-resource-pages.mjs
node scripts/build-pricing-page.mjs
node scripts/build-provider-pages.mjs
```

Each generator has `--check`; CI also checks resource metadata, structured data, source references, local assets, fragments, and discovery through hubs and the sitemap. Resource sitemap entries are inserted before provider entries so the generators remain stable in any normal verification order. Canonical URLs use `https://www.adport.dev` and Vercel clean URLs.

Existing brand assets are reused directly from the homepage: Google Ads, Meta, Claude, ChatGPT, and MCP marks. No invented customer performance, testimonials, stock dashboard screenshots, or traffic statistics are used.

Dashboard controls live in `components/controls.tsx`, `select.tsx`, `dialog.tsx`, `info-tooltip.tsx`, and `use-confirm.tsx`. Selects support keyboard navigation and form resets. Native dialog top-layer behavior supplies focus containment; custom popups portal inside the current dialog so they remain visible. Important errors, destructive-action context, and retired-workspace instructions stay visible. Routine help moves to tooltips.

The navigation groups account connections and approval history into their related sections. Project and organization forms use compact lists and editing dialogs. Team-page project renaming was removed because Projects already supplies it. Provider reads, project permissions, and the advertising write gate retain their existing server contracts. Dashboard performance consumes the existing registry's currency-separated summary, including null/unavailable metrics and weighted ROAS; no new metric engine or tool definition was added.

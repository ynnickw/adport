# Provider landing pages

The site has a browsable `/providers` directory and one static page per supported advertising provider. Content is rendered into HTML, not fetched by client JavaScript. There are no separate near-duplicate pages for each spelling or AI client.

## Search intent and page map

Primary intent: connect an existing advertising account to an MCP-compatible AI agent. These are editorial keyword targets informed by public search results and the product surface, not measured keyword volumes or ranking forecasts.

| Page | Main query family | Additional intent covered on the same page |
| --- | --- | --- |
| `/providers/google-ads` | Google Ads MCP | Google Ads in Claude Code, Cursor, ChatGPT; GAQL/search-term analysis |
| `/providers/meta-ads` | Meta Ads MCP | Facebook Ads MCP, Instagram ads, Insights and ad-set budgets |
| `/providers/tiktok-ads` | TikTok Ads MCP | TikTok Business API, sandbox, advertiser reporting |
| `/providers/apple-ads` | Apple Ads MCP | Apple Search Ads MCP, API-user keys, App Store acquisition |
| `/providers/microsoft-ads` | Microsoft Ads MCP | Bing Ads MCP, Microsoft Advertising, asynchronous reports |
| `/providers/reddit-ads` | Reddit Ads MCP | Reddit advertising in Claude, CBO budgets and write permissions |
| `/providers/snapchat-ads` | Snapchat Ads MCP | Snap Marketing API, ad squads, swipes and purchase reporting |
| `/providers/spotify-ads` | Spotify Ads MCP | Advertising rather than music, ad sets and unpublished drafts |
| `/providers/pinterest-ads` | Pinterest Ads MCP | Checkout reporting, CBO campaigns, API access requirements |
| `/providers/linkedin-ads` | LinkedIn Ads MCP | B2B advertising, campaign groups, creative reports |
| `/providers/x-ads` | X Ads MCP | Twitter Ads MCP, OAuth 1.0a, line items and link-click reporting |

Each page includes three provider-specific workflows, three example prompts (clearly labeled as examples), prerequisites, a local connection guide, HTTP/OAuth setup for ChatGPT, Codex, Claude Code, Claude, Cursor, and VS Code, reporting caveats, FAQs, related integrations, and the shared waitlist form. The Cloud waitlist is separate from MCP client setup. The endpoint appears in copyable setup code; no navigation link points to the app host.

## Evidence and boundaries

- npm `adport` 0.6.0 was checked on 2026-08-31 and includes all 11 provider dependencies.
- Product claims come from the provider tool definitions, local connection wizards, `docs/providers.md`, and `docs/providers/*.md`. API-contract tests are not represented as live advertiser approval.
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) supports the stdio registration pattern.
- [Cursor MCP documentation](https://cursor.com/docs/context/mcp) describes command/args configuration.
- [Google's spam policies](https://developers.google.com/search/docs/essentials/spam-policies#doorway-abuse) and [people-first content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) informed standalone, useful guides rather than repeated keyword-only signup pages.
- No invented reviews, customer metrics, search volumes, partnerships, or ranking guarantees. Structured data contains WebPage and BreadcrumbList, not fake review or offer markup.

Agent instructions and HTTP commands match `apps/cloud/app/dashboard/agents/agent-setup-guide.tsx`; parity tests cover all six clients. Local npm/stdio remains an alternative for compatible clients, not the ChatGPT transport.

## Maintenance

Edit `scripts/website-providers.mjs` for provider copy, `scripts/build-provider-pages.mjs` for the shared static template, and `website/providers.css` for layout. The generator reuses the current homepage header, inline hero form, footer, waitlist, and local provider logos. It preserves existing sitemap entries and links the homepage's provider logos to the corresponding pages.

```sh
node scripts/build-provider-pages.mjs
node scripts/build-provider-pages.mjs --check
node --test scripts/test-provider-pages.mjs
```

Commit the generated HTML. Vercel serves it with the existing clean URL configuration; no framework change or build dependency is required. If shared homepage markup changes, regenerate provider pages. Follow static checks with browser checks for desktop/mobile layout, keyboard focus, copying, and form feedback. Test signups against a local fixture rather than populating the production waitlist.

The sitemap makes pages discoverable; deployment does not guarantee search indexing or ranking. Search Console submission is not part of the generator.

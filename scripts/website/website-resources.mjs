import { aiArticles } from './resource-content/ai-ads.mjs';
import { optimizationArticles } from './resource-content/optimization.mjs';
import { agencyArticles } from './resource-content/agencies.mjs';
import { claudeArticles } from './resource-content/claude-connections.mjs';
import { chatgptArticles } from './resource-content/chatgpt-connections.mjs';
import { marketingAnalyticsArticles } from './resource-content/marketing-analytics.mjs';
import { metaReportingArticles } from './resource-content/meta-reporting.mjs';
import { paidSearchArticles } from './resource-content/paid-search.mjs';
import { appleAcquisitionArticles } from './resource-content/apple-acquisition.mjs';
export { sources } from './resource-content/shared.mjs';

export const published = '2026-11-01';
export const workflowClusters = [
  {
    slug: 'meta-ads-reporting', title: 'Meta Ads creative reporting',
    audience: 'For paid social teams', task: 'Decide which Meta ad to refresh', providers: ['meta'],
    description: 'Compare ad frequency, link clicks and purchases across Facebook and Instagram before briefing your designer.',
    intro: 'When a Meta ad stops bringing in purchases, the buyer and the designer need to know where response changed. Use Adport to inspect the ad and its delivery in your AI assistant. Start with a creative fatigue check or look up where Facebook and Instagram actually showed the ad.',
    firstReport: 'Connect a Meta ad account on the free plan and compare two weeks of delivery for one ad set.',
  },
  {
    slug: 'paid-search-reporting', title: 'Paid search reporting',
    audience: 'For paid search teams', task: 'Compare Google and Microsoft Ads', providers: ['google', 'microsoft'],
    description: 'Find the campaigns behind a change in weekly search spend and the queries that brought people to your site.',
    intro: 'When someone asks where the search budget went, give them a report they can trace back to both accounts. Use Adport to read Google Ads and Microsoft Advertising in one conversation. Compare campaign spend for the week, then follow the search terms or the budget that needs a closer look.',
    firstReport: 'Connect your search accounts on the free plan and ask which campaigns explain this week’s change in spend.',
  },
  {
    slug: 'apple-ads-for-app-developers', title: 'Apple Ads for app developers',
    audience: 'For app developers', task: 'Find what an App Store download costs', providers: ['apple'],
    description: 'Measure the cost of a first download, find useful App Store search terms and plan a paused Apple Ads campaign.',
    intro: 'If you build an iOS app and run your own ads, start with one app in one storefront. Ask your AI assistant what you spent per first download, which searches found the app, or what a first search results campaign would look like. Each guide starts from the Apple Ads data you need for that decision.',
    firstReport: 'Connect an Apple Ads account and run a read-only report for one app and storefront on the free plan.',
  },
];
export const clusters = [
  ...workflowClusters,
  { slug: 'connect-ads-to-claude', title: 'Connect ads to Claude', description: 'Connect Google, Meta, TikTok, Snapchat, LinkedIn, Microsoft, and Reddit Ads to Claude or Claude Code with MCP.', intro: 'Choose your advertising platform for the account setup, Claude Code commands, and a useful first report. Start with the shared MCP setup if you manage several platforms, then follow the guide for the metrics and permissions that matter to your account.', keywords: ['connect Google Ads to Claude', 'connect Meta Ads to Claude', 'connect Snapchat Ads to Claude Code', 'Claude Code ads'] },
  { slug: 'connect-ads-to-chatgpt', title: 'Connect ads to ChatGPT', description: 'Connect Google, Meta, TikTok, Snapchat, LinkedIn, and Microsoft Ads to ChatGPT with an MCP plugin and OAuth.', intro: 'Install Adport in ChatGPT, authorize the right client project, and verify the advertising accounts available to your conversation. Start with the shared plugin setup, then choose a provider guide for useful reporting prompts, measurement checks, and troubleshooting.', keywords: ['connect ad accounts to ChatGPT', 'Google Ads ChatGPT', 'Facebook Ads ChatGPT', 'Snapchat Ads ChatGPT', 'ChatGPT MCP advertising'] },
  { slug: 'ai-ad-management', title: 'AI ad management', description: 'Connect AI assistants to real advertising accounts and build a useful review workflow.', intro: 'An AI assistant is more useful when it can work with the account you mean. These guides start with project scope and authorization, then show how to ask grounded questions and review exact changes. Choose your preferred client, verify a small read, and build the same repeatable process around it.', keywords: ['Google Ads MCP server', 'Claude Google Ads', 'Google Ads ChatGPT', 'Codex Google Ads'] },
  { slug: 'google-ads-optimization', title: 'Google Ads optimization', description: 'Audit measurement, review search intent, and keep spending aligned with the plan.', intro: 'A useful account review starts with reliable measurement and a clear business question. Work through the audit before making isolated changes. Then use the search-term and budget-pacing guides to investigate specific issues, record the evidence, and choose a small action you can verify.', keywords: ['Google Ads audit checklist', 'Google Ads negative keywords', 'Google Ads budget pacing'] },
  { slug: 'marketing-analytics', title: 'Marketing analytics with MCP', description: 'Connect GA4 and Google Search Console to your AI assistant, review organic search, and check conversion differences across Google Ads and GA4.', intro: 'Measure what happens before and after someone reaches your site. Use Google Search Console for organic search queries and clicks, GA4 for sessions and events, and Google Ads for campaign performance and attributed conversions. Connect the properties you need and compare each report on its own terms.' },
  { slug: 'agency-operations', title: 'Agency operations', description: 'Keep clients separate, give people the right access, and report numbers they can use.', intro: 'A repeatable agency process needs clear client boundaries as much as useful reports. Organize projects, assign the right people, and keep commercial approval alongside exact advertising previews. These guides connect the permission model to the day-to-day work of client reporting and decision-making.', keywords: ['agency ad management', 'Google Ads read only access', 'CPA vs ROAS'] },
];
export const articles = [...metaReportingArticles, ...paidSearchArticles, ...appleAcquisitionArticles, ...claudeArticles, ...chatgptArticles, ...aiArticles, ...optimizationArticles, ...marketingAnalyticsArticles, ...agencyArticles];
export const articlesInCluster = slug => articles.filter(article => article.cluster === slug || article.relatedClusters?.includes(slug));

import { aiArticles } from './resource-content/ai-ads.mjs';
import { optimizationArticles } from './resource-content/optimization.mjs';
import { agencyArticles } from './resource-content/agencies.mjs';
export { sources } from './resource-content/shared.mjs';

export const published = '2026-11-01';
export const clusters = [
  { slug: 'ai-ad-management', title: 'AI ad management', description: 'Connect AI assistants to real advertising accounts and build a useful review workflow.', intro: 'An AI assistant is more useful when it can work with the account you mean. These guides start with project scope and authorization, then show how to ask grounded questions and review exact changes. Choose your preferred client, verify a small read, and build the same repeatable process around it.', keywords: ['Google Ads MCP server', 'Claude Google Ads', 'Google Ads ChatGPT', 'Codex Google Ads'] },
  { slug: 'google-ads-optimization', title: 'Google Ads optimization', description: 'Audit measurement, review search intent, and keep spending aligned with the plan.', intro: 'A useful account review starts with reliable measurement and a clear business question. Work through the audit before making isolated changes. Then use the search-term and budget-pacing guides to investigate specific issues, record the evidence, and choose a small action you can verify.', keywords: ['Google Ads audit checklist', 'Google Ads negative keywords', 'Google Ads budget pacing'] },
  { slug: 'agency-operations', title: 'Agency operations', description: 'Keep clients separate, give people the right access, and report numbers they can use.', intro: 'A repeatable agency process needs clear client boundaries as much as useful reports. Organize projects, assign the right people, and keep commercial approval alongside exact advertising previews. These guides connect the permission model to the day-to-day work of client reporting and decision-making.', keywords: ['agency ad management', 'Google Ads read only access', 'CPA vs ROAS'] },
];
export const articles = [...aiArticles, ...optimizationArticles, ...agencyArticles];

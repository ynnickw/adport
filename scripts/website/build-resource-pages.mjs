import { withSupport } from './website-support.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { articles, articlesInCluster, clusters, published, sources, workflowClusters } from './website-resources.mjs';
import { escape } from './resource-content/shared.mjs';
import { providers } from './website-providers.mjs';
import { cloudSignupUrl } from './website-agent-setups.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const site = path.join(root, 'website');
const check = process.argv.includes('--check');
const home = await readFile(path.join(site, 'index.html'), 'utf8');
const header = home.match(/<header class="site-header">[\s\S]*?<\/header>/)?.[0];
const footer = home.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)?.[0];
if (!header || !footer) throw new Error('Shared header/footer missing.');
const clusterFor = article => clusters.find(cluster => cluster.slug === article.cluster);
const url = article => `/resources/${article.slug}`;
const publicationDate = article => article.published ?? published;
const lastModified = article => article.updated ?? publicationDate(article);
const latestModification = items => items.map(lastModified).sort().at(-1);
const formatDate = date => new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(date));
const words = article => (article.intro + ' ' + article.sections.map(section => `${section.title} ${section.html.replace(/<[^>]*>/g, ' ')}`).join(' ')).trim().split(/\s+/).length;
const minutes = article => Math.ceil(words(article) / 200);
const mark = id => {
  let svg;
  if (providers.some(provider => provider.id === id)) svg = home.match(new RegExp(`<svg[^>]*class="${id}-logo"[\\s\\S]*?<\\/svg>`))?.[0];
  else if (id === 'mcp') svg = home.match(/<svg class="agent-brand-logo agent-brand-mcp"[\s\S]*?<\/svg>/)?.[0];
  else { const source = home.match(new RegExp(`<span class="agent agent-${id}">[\\s\\S]*?<\\/svg>`))?.[0]; svg = source?.slice(source.indexOf('<svg')); }
  if (!svg) throw new Error(`Real brand asset missing: ${id}`);
  return `<span class="resource-mark" aria-hidden="true">${svg}</span>`;
};
const marks = ids => `<div class="resource-marks" aria-hidden="true">${ids.map(mark).join('<span class="resource-connector">+</span>')}</div>`;
const resourceCard = ({ slug, brands, meta, title, summary, action }) => `<article class="resource-card"><a href="/resources/${escape(slug)}">${marks(brands)}<span class="resource-card-meta">${escape(meta)}</span><h3>${escape(title)}</h3><p>${escape(summary)}</p><span class="resource-read">${escape(action)} <span aria-hidden="true">↗</span></span></a></article>`;
const card = article => resourceCard({
  slug: article.slug, brands: article.marks, meta: `${clusterFor(article).title} · ${minutes(article)} min read`,
  title: article.title, summary: article.summary, action: 'Read guide',
});
const workflowCard = cluster => resourceCard({
  slug: cluster.slug, brands: cluster.providers, meta: cluster.audience,
  title: cluster.task, summary: cluster.description, action: 'Explore guides',
});
const breadcrumbs = (cluster, article) => `<nav class="resource-breadcrumbs" aria-label="Breadcrumb"><a href="/resources">Resources</a>${cluster ? `<span aria-hidden="true">/</span>${article ? `<a href="/resources/${cluster.slug}">${escape(cluster.title)}</a>` : `<span aria-current="page">${escape(cluster.title)}</span>`}` : ''}${article ? '<span aria-hidden="true">/</span><span aria-current="page">Guide</span>' : ''}</nav>`;
const cta = cluster => `<section class="resource-cta"><div><h2>Try Adport Cloud</h2><p>${escape(cluster?.firstReport ?? 'Connect your ad accounts and run your first report with the free plan.')}</p></div><div><a class="resource-primary" href="${cloudSignupUrl}">Start free</a><a href="/pricing">Compare plans</a></div></section>`;
function document({ title, description, pathname, content, article, cluster }) {
  const canonical = `https://www.adport.dev${pathname}`;
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Adport', item: 'https://www.adport.dev/' }, { '@type': 'ListItem', position: 2, name: 'Resources', item: 'https://www.adport.dev/resources' }];
  if (cluster) crumbs.push({ '@type': 'ListItem', position: 3, name: cluster.title, item: `https://www.adport.dev/resources/${cluster.slug}` });
  if (article) crumbs.push({ '@type': 'ListItem', position: 4, name: article.title, item: canonical });
  const entity = article ? { '@type': 'Article', headline: article.title, description, mainEntityOfPage: canonical,
    author: { '@type': 'Organization', name: 'Adport', url: 'https://www.adport.dev' },
    publisher: { '@type': 'Organization', name: 'Adport', url: 'https://www.adport.dev', logo: { '@type': 'ImageObject', url: 'https://www.adport.dev/meta-app-icon.png' } },
    datePublished: article.published ?? `${published}T00:00:00+07:00`, dateModified: article.updated ?? article.published ?? `${published}T00:00:00+07:00`, articleSection: cluster.title, wordCount: words(article), image: 'https://www.adport.dev/og-image.png?v=8' }
    : { '@type': 'CollectionPage', name: title, description, url: canonical, mainEntity: { '@type': 'ItemList', itemListElement: (cluster ? articlesInCluster(cluster.slug) : articles).map((a, i) => ({ '@type': 'ListItem', position: i + 1, name: a.title, url: `https://www.adport.dev${url(a)}` })) } };
  const schema = { '@context': 'https://schema.org', '@graph': [entity, { '@type': 'BreadcrumbList', itemListElement: crumbs }] };
  return withSupport(`<!doctype html>
<!-- Generated by scripts/website/build-resource-pages.mjs. Edit scripts/website/resource-content/*.mjs. -->
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title><meta name="description" content="${escape(description)}" /><link rel="canonical" href="${canonical}" />
<meta property="og:type" content="${article ? 'article' : 'website'}" /><meta property="og:site_name" content="Adport" /><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta property="og:url" content="${canonical}" /><meta property="og:image" content="https://www.adport.dev/og-image.png?v=8" />
<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:title" content="${escape(title)}" /><meta name="twitter:description" content="${escape(description)}" /><meta name="twitter:image" content="https://www.adport.dev/og-image.png?v=8" />
<link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" /><link rel="preload" href="/fonts/overpass-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin /><link rel="stylesheet" href="/site.css" /><link rel="stylesheet" href="/resources.css" /><script src="/site.js" defer></script>
<script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script></head>
<body class="resources-page"><a class="skip-link" href="#main">Skip to content</a>${header.replace('<a href="/resources">', '<a href="/resources" aria-current="page">')}
<main id="main" class="resources-main">${content}${cta(cluster)}</main>${footer}</body></html>\n`);
}
const output = new Map();
output.set('resources.html', document({ title: 'Adport resources | ChatGPT, Claude & ads MCP guides', description: 'Review paid search, Meta creative and App Store acquisition. Find MCP setup guides for ChatGPT and Claude, campaign reporting, GA4 and Search Console.', pathname: '/resources', content: `${breadcrumbs()}<section class="resources-hero"><p class="resource-eyebrow">The Adport field guide</p><h1>Useful guides for people who run ads.</h1><p>Choose the work in front of you, from reviewing a Meta ad to measuring an App Store download. You can also start with your AI assistant or an account setup guide.</p><nav class="resource-topics" aria-label="Guide topics">${clusters.map(c => `<a href="#${c.slug}">${escape(c.title)}<span>${articlesInCluster(c.slug).length}</span></a>`).join('')}</nav></section>
${clusters.map(c => `<section class="resource-cluster" id="${c.slug}" aria-labelledby="${c.slug}-title"><div class="resource-section-head"><div><h2 id="${c.slug}-title">${escape(c.title)}</h2><p>${escape(c.description)}</p></div><a href="/resources/${c.slug}">Explore topic <span aria-hidden="true">↗</span></a></div><div class="resource-grid">${articlesInCluster(c.slug).map(card).join('\n')}</div></section>`).join('\n')}` }));
for (const cluster of clusters) {
  const setupLinks = cluster.providers?.map(id => {
    const provider = providers.find(p => p.id === id);
    return `<a href="/providers/${escape(provider.slug)}">Connect ${escape(provider.name)}</a>`;
  });
  output.set(`resources/${cluster.slug}.html`, document({ title: `${cluster.title} guides | Adport`, description: cluster.description, pathname: `/resources/${cluster.slug}`, cluster,
    content: `${breadcrumbs(cluster)}<section class="resources-hero resource-topic-hero"><p class="resource-eyebrow">Guides & workflows</p><h1>${escape(cluster.title)}</h1><p>${escape(cluster.intro)}</p>${setupLinks ? `<nav class="resource-topics" aria-label="Account setup">${setupLinks.join('')}</nav>` : ''}</section><section class="resource-cluster"><div class="resource-section-head"><h2>Start here</h2><span>${articlesInCluster(cluster.slug).length} guides</span></div><div class="resource-grid">${articlesInCluster(cluster.slug).map(card).join('\n')}</div></section>` }));
}
for (const article of articles) {
  const cluster = clusterFor(article);
  const accessNote = article.sections.some(s => s.html.includes('https://app.adport.dev'))
    ? `<p><a href="${cloudSignupUrl}">Create a free Adport Cloud account</a> to follow the hosted setup instructions below.</p>` : '';
  output.set(`resources/${article.slug}.html`, document({ title: `${article.title} | Adport`, description: article.description, pathname: url(article), article, cluster,
    content: `${breadcrumbs(cluster, article)}<article class="guide"><header class="guide-header">${marks(article.marks)}<h1>${escape(article.title)}</h1><p class="guide-deck">${escape(article.intro)}</p><div class="guide-meta"><span>By Adport</span><time datetime="${publicationDate(article)}">${formatDate(publicationDate(article))}</time>${article.updated ? `<span>Updated <time datetime="${article.updated}">${formatDate(article.updated)}</time></span>` : ''}<span>${minutes(article)} min read</span></div></header>
<div class="guide-layout"><aside class="guide-toc"><nav aria-label="In this guide"><p>In this guide</p>${article.sections.map(s => `<a href="#${s.id}">${escape(s.title)}</a>`).join('')}<a href="#sources">Sources</a></nav></aside><div class="guide-body">${accessNote}${article.sections.map(s => `<section id="${s.id}"><h2>${escape(s.title)}</h2>${s.html}</section>`).join('\n')}<section class="guide-sources" id="sources"><h2>Sources & further reading</h2><p>Provider documentation for the setup and platform behavior described above.</p><ul>${article.sources.map(id => `<li><a href="${escape(sources[id].url)}" rel="noreferrer">${escape(sources[id].title)}</a><span>${new URL(sources[id].url).hostname}</span></li>`).join('')}</ul></section></div></div></article>
<section class="resource-related"><div class="resource-section-head"><h2>Keep reading</h2><a href="/resources/${cluster.slug}">${escape(cluster.title)} <span aria-hidden="true">↗</span></a></div><div class="resource-grid">${articlesInCluster(cluster.slug).filter(a => a.slug !== article.slug).slice(0, 3).map(card).join('')}</div></section>` }));
}
const featured = [
  ['google-ads-mcp-server', 'Google Ads MCP setup'],
  ['google-ads-audit-checklist', 'Google Ads audit checklist'],
  ['agency-multi-client-ad-management', 'Multi-client ad management'],
  ['marketing-analytics', 'GA4 and Search Console'],
];
const claudeFeatured = ['meta-ads-with-claude', 'snapchat-ads-with-claude', 'tiktok-ads-with-claude'].map(slug => articles.find(a => a.slug === slug));
const chatgptFeatured = ['google-ads-with-chatgpt', 'meta-ads-with-chatgpt', 'snapchat-ads-with-chatgpt'].map(slug => articles.find(a => a.slug === slug));
const landing = `<!-- resources:start -->\n<section class="landing-resources" id="workflow-guides" aria-labelledby="resources-title"><div class="resource-section-head"><div><p class="resource-eyebrow">Resources</p><h2 id="resources-title">What do you want to learn from your ads?</h2></div><a href="/resources">All guides <span aria-hidden="true">↗</span></a></div><div class="resource-grid">${workflowClusters.map(workflowCard).join('')}</div><nav class="resource-topics" aria-label="More advertising guides">${featured.map(([slug, label]) => `<a href="/resources/${slug}">${escape(label)}</a>`).join('')}</nav><div class="landing-claude-guides" aria-labelledby="claude-guides-title"><div class="resource-section-head"><div><p class="resource-eyebrow">Connect your ad stack</p><h2 id="claude-guides-title">Your ad accounts, connected to Claude.</h2><p>Pick your platform for setup steps, a useful first report, and the details that matter to your campaigns.</p></div><a href="/resources/connect-ads-to-claude">All Claude setup guides <span aria-hidden="true">↗</span></a></div><div class="resource-grid">${claudeFeatured.map(card).join('')}</div><nav class="resource-topics" aria-label="More Claude setup guides"><a href="/resources/connect-ads-to-claude-code">Claude Code MCP setup</a><a href="/resources/google-ads-with-claude">Google Ads</a><a href="/resources/linkedin-ads-with-claude">LinkedIn Ads</a><a href="/resources/microsoft-ads-with-claude">Microsoft &amp; Bing Ads</a></nav></div><div class="landing-chatgpt-guides" aria-labelledby="chatgpt-guides-title"><div class="resource-section-head"><div><p class="resource-eyebrow">Connect through ChatGPT</p><h2 id="chatgpt-guides-title">Your ad accounts, connected to ChatGPT.</h2><p>Install the MCP plugin, choose a client project, and ask campaign questions grounded in your account data.</p></div><a href="/resources/connect-ads-to-chatgpt">All ChatGPT setup guides <span aria-hidden="true">↗</span></a></div><div class="resource-grid">${chatgptFeatured.map(card).join('')}</div><nav class="resource-topics" aria-label="More ChatGPT setup guides"><a href="/resources/connect-ads-to-chatgpt-mcp">ChatGPT MCP setup</a><a href="/resources/tiktok-ads-with-chatgpt">TikTok Ads</a><a href="/resources/linkedin-ads-with-chatgpt">LinkedIn Ads</a><a href="/resources/microsoft-ads-with-chatgpt">Microsoft &amp; Bing Ads</a></nav></div></section>\n      <!-- resources:end -->`;
const marker = /<!-- resources:start -->[\s\S]*?<!-- resources:end -->/;
if (!marker.test(home)) throw new Error('Homepage resource markers missing.');
output.set('index.html', home.replace(marker, landing));
let sitemap = await readFile(path.join(site, 'sitemap.xml'), 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/www\.adport\.dev\/resources(?:\/[^<]+)?<\/loc>(?:<lastmod>[^<]+<\/lastmod>)?<\/url>/g, '');
const paths = [
  ['/resources', latestModification(articles)],
  ...clusters.map(c => [`/resources/${c.slug}`, latestModification(articlesInCluster(c.slug))]),
  ...articles.map(article => [url(article), lastModified(article)]),
];
const entries = paths.map(([resourcePath, lastmod]) => `  <url><loc>https://www.adport.dev${resourcePath}</loc><lastmod>${lastmod}</lastmod></url>`).join('\n');
const providerAnchor = '  <url><loc>https://www.adport.dev/providers</loc></url>';
sitemap = sitemap.includes(providerAnchor) ? sitemap.replace(providerAnchor, `${entries}\n${providerAnchor}`) : sitemap.replace('</urlset>', `${entries}\n</urlset>`);
output.set('sitemap.xml', sitemap);
let stale = false;
for (const [file, content] of output) {
  const target = path.join(site, file);
  const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current === content) continue;
  if (check) { console.error(`Out of date: website/${file}`); stale = true; continue; }
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Generated'} Resources hub, ${clusters.length} topic hubs, ${articles.length} guides, landing section, and sitemap.`);

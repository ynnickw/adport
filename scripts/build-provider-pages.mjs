import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { providers } from './website-providers.mjs';
import { agentSetups, mcpBaseUrl } from './website-agent-setups.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = path.join(root, 'website');
const check = process.argv.includes('--check');
const home = await readFile(path.join(site, 'index.html'), 'utf8');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const get = pattern => {
  const result = home.match(pattern)?.[0];
  if (!result) throw new Error(`Landing component not found: ${pattern}`);
  return result;
};
const header = get(/<header class="site-header">[\s\S]*?<\/header>/);
const footer = get(/<footer class="site-footer">[\s\S]*?<\/footer>/);
const signup = get(/<div class="hero-signup">[\s\S]*?<\/form>\s*<\/div>/);
const github = get(/<a class="text-action github-link"[\s\S]*?<\/a>/);
const waitlist = get(/<section class="waitlist"[\s\S]*?<\/section>/);
const logo = provider => get(new RegExp(`<svg[^>]*class="${provider.id}-logo"[\\s\\S]*?<\\/svg>`));
const agentLogo = id => {
  // Same VS Code mark as the Cloud app's VscVscode component.
  if (id === 'vscode') return '<svg class="agent-brand-logo agent-brand-vscode" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M15.434 1.72887L12.14 0.144875C12.002 0.078875 11.855 0.046875 11.709 0.046875C11.353 0.046875 11.18 0.211875 11.155 0.228875C11.073 0.270875 11.005 0.337875 11.004 0.338875L4.698 6.08888L1.951 4.00488C1.832 3.91388 1.69 3.86987 1.548 3.86987C1.387 3.86987 1.226 3.92788 1.1 4.04288L0.219 4.84387C0.074 4.97587 0.001 5.15688 0.001 5.33687C0.001 5.51687 0.073 5.69688 0.218 5.82888L2.6 8.00088L0.217 10.1719C0.072 10.3039 0 10.4839 0 10.6639C0 10.8439 0.073 11.0249 0.218 11.1569L1.099 11.9579C1.226 12.0729 1.386 12.1309 1.547 12.1309C1.688 12.1309 1.83 12.0859 1.95 11.9959L4.697 9.91187L11.003 15.6619C11.003 15.6619 11.072 15.7299 11.155 15.7719C11.179 15.7889 11.353 15.9529 11.709 15.9529C11.855 15.9529 12.003 15.9209 12.141 15.8549L15.435 14.2709C15.781 14.1049 16.001 13.7539 16.001 13.3699V2.62888C16.001 2.24487 15.781 1.89488 15.435 1.72787L15.434 1.72887ZM7.217 7.99988L12.002 4.36987V11.6299L7.217 7.99988Z"/></svg>';
  const markup = get(new RegExp(`<span class="agent agent-${id}">[\\s\\S]*?<\\/svg>`));
  return markup.slice(markup.indexOf('<svg')).replace('<svg ', `<svg class="agent-brand-logo agent-brand-${id}" aria-hidden="true" focusable="false" `);
};
const href = provider => `/providers/${provider.slug}`;
const code = text => `<pre><code>${escape(text)}</code></pre>`;
const copy = (text, label) => `<button class="text-action copy-chip" type="button" data-copy-command="${escape(text)}"><span class="copy-label" aria-live="polite">${escape(label)}</span></button>`;
const cmd = (text, label = 'Copy') => `<div class="cmd${text.includes('\n') ? ' cmd-block' : ''}">${text.includes('\n') ? code(text) : `<code>${escape(text)}</code>`}${copy(text, label)}</div>`;
const setupTabs = (context = 'your ads') => `<div class="agent-setup" data-agent-tabs>
  <p class="agent-setup-intro">Use the same Adport MCP endpoint and OAuth sign-in in each client. First connect your ad accounts in your Adport workspace. No platform secrets belong in chat.</p>
  <div class="agent-tab-list" role="tablist" aria-label="AI tool setup instructions" hidden>${agentSetups.map((agent, i) => `<button class="agent-tab" type="button" role="tab" id="agent-tab-${agent.id}" aria-controls="agent-panel-${agent.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${agent.logo ? agentLogo(agent.logo) : ''}<span>${agent.name}</span></button>`).join('')}</div>
  ${agentSetups.map(agent => `<div class="agent-instructions" id="agent-panel-${agent.id}" role="tabpanel" aria-labelledby="agent-tab-${agent.id}" tabindex="0"><h3>Use ${escape(context)} in ${agent.name}</h3><p>${escape(agent.instructions)}</p>${cmd(agent.command(mcpBaseUrl), `Copy ${agent.name} setup`)}<p class="agent-next">${escape(agent.nextStep)}</p>${agent.id === 'chatgpt' ? '<p class="agent-note">Developer mode and custom apps must be enabled for your ChatGPT account or workspace. In newer layouts, enable Developer mode under Settings → Security and login, then use the + button in Plugins to create your app. ChatGPT connects over HTTP; the local stdio command is for clients that can launch a process.</p><p><a class="text-link" href="https://developers.openai.com/api/docs/guides/developer-mode">ChatGPT developer-mode documentation</a></p>' : ''}</div>`).join('')}
  <p class="local-option">Use the MCP URL from Agent access if you run your own Adport deployment. Client settings, workspace permissions, and advertising-platform approvals still apply. The Cloud waitlist below is separate from these connection instructions.</p>
</div>`;
const homeSetup = () => `<!-- agent-setup:start -->
      <section class="setup" id="setup" aria-labelledby="agent-title">
        <div class="section-intro">
          <h2 id="agent-title">One URL. Your choice of AI.</h2>
        </div>
        <div class="setup-layout">
          ${setupTabs()}
          <aside class="setup-local" aria-labelledby="local-title">
            <h3 id="local-title">Prefer to run it locally?</h3>
            <p class="setup-sub">Open source under Apache-2.0. Bring your own credentials; Node.js 22.13 or newer.</p>
            <ol class="steps">
              <li><span class="step-title">Install the CLI</span>${cmd('npm install -g adport')}</li>
              <li><span class="step-title">Connect a platform</span>${cmd('adport connect google')}</li>
              <li><span class="step-title">Register the local server</span>${cmd('claude mcp add --transport stdio adport -- adport mcp')}</li>
            </ol>
          </aside>
        </div>
      </section>
<!-- agent-setup:end -->`;
const card = p => `<li><a href="${href(p)}">${logo(p)}<span class="pg-text"><span class="pg-name">${escape(p.name)}</span><span class="pg-label">${escape(p.label)}</span></span></a></li>`;

function document({ title, description, pathname, content, name }) {
  const canonical = `https://www.adport.dev${pathname}`;
  const crumbs = [{ '@type': 'ListItem', position: 1, name: 'Adport', item: 'https://www.adport.dev/' }, { '@type': 'ListItem', position: 2, name: 'Ad integrations', item: 'https://www.adport.dev/providers' }];
  if (pathname !== '/providers') crumbs.push({ '@type': 'ListItem', position: 3, name, item: canonical });
  const schema = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebPage', '@id': `${canonical}#webpage`, url: canonical, name: title, description, inLanguage: 'en', isPartOf: { '@type': 'WebSite', name: 'Adport', url: 'https://www.adport.dev/' } },
    { '@type': 'BreadcrumbList', itemListElement: crumbs },
  ] };
  return `<!doctype html>
<!-- Generated by scripts/build-provider-pages.mjs. Edit scripts/website-providers.mjs or the shared template. -->
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(description)}" />
  <meta name="theme-color" content="#f5f5f7" />
  <link rel="canonical" href="${canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Adport" />
  <meta property="og:title" content="${escape(title)}" />
  <meta property="og:description" content="${escape(description)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="https://www.adport.dev/og-image.png?v=5" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Adport — Your agent proposes. You see the diff. Then it runs." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escape(title)}" />
  <meta name="twitter:description" content="${escape(description)}" />
  <meta name="twitter:image" content="https://www.adport.dev/og-image.png?v=5" />
  <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
  <link rel="preload" href="/fonts/overpass-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/site.css" />
  <link rel="stylesheet" href="/providers.css" />
  <script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>
  <script src="/site.js" defer></script>
</head>
<body class="provider-page">
  <a class="skip-link" href="#main">Skip to content</a>
  ${header}
  ${content}
  ${waitlist}
  ${footer}
</body>
</html>
`;
}

function providerPage(p) {
  const install = 'npm install -g adport';
  const connect = `adport connect ${p.id}`;
  const check = `adport doctor\nadport accounts --provider ${p.id}`;
  return document({ title: `${p.name} MCP for Claude, Cursor & ChatGPT | Adport`, description: p.description, pathname: href(p), name: p.name,
    content: `<main class="provider" id="main">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Adport</a><span aria-hidden="true">/</span><a href="/providers">Integrations</a><span aria-hidden="true">/</span><span aria-current="page">${escape(p.name)}</span></nav>
    <section class="p-hero" aria-labelledby="provider-title">
      <div class="p-hero-copy">
        <p class="p-kicker"><span class="p-logo">${logo(p)}</span>${escape(p.name)} MCP server</p>
        <h1 id="provider-title">${escape(p.name)}, from your AI agent.</h1>
        <p class="lede">${escape(p.intro)}</p>
        <div class="hero-actions">${signup}${github}</div>
        <p class="local-option">Prefer to run it on your machine? <a class="text-link" href="#connect">Local setup for ${escape(p.name)}</a></p>
      </div>
      <aside class="console p-prompts" aria-label="Example prompts for ${escape(p.name)}">
        <div class="console-bar"><span class="console-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="console-title">${escape(p.label)}</span></div>
        <ol class="p-prompt-list">${p.prompts.map(text => `<li class="msg msg-user"><span class="who">You</span><p>${escape(text)}</p></li>`).join('')}</ol>
        <p class="p-prompt-note">Example prompts, not live results. Your agent uses the accounts and permissions you connect.</p>
      </aside>
    </section>

    <section class="p-section" aria-labelledby="capabilities-title">
      <div class="section-intro"><h2 id="capabilities-title">What you can do with ${escape(p.name)} MCP</h2></div>
      <div class="p-workflows">${p.workflows.map(([title, text]) => `<article><h3>${escape(title)}</h3><p>${escape(text)}</p></article>`).join('')}</div>
      <aside class="p-nuance" aria-labelledby="nuance-title"><h3 id="nuance-title">Know what the data means</h3><p>${escape(p.nuance)}</p></aside>
    </section>

    <section class="p-section" id="connect" aria-labelledby="connect-title">
      <div class="section-intro">
        <h2 id="connect-title">Prefer local setup for ${escape(p.name)}?</h2>
        <p>The npm CLI and MCP server run on your machine. You need Node.js 22.13 or newer, your own provider credentials, and permission to access the ad account.</p>
      </div>
      <div class="p-connect">
        <ol class="steps">
          <li><span class="step-title">Install Adport</span>${cmd(install, 'Copy')}</li>
          <li><span class="step-title">Connect ${escape(p.name)}</span>${cmd(connect, 'Copy')}<span class="step-text">${escape(p.connection)}</span></li>
          <li><span class="step-title">Check your connection</span>${cmd(check, 'Copy')}<span class="step-text">Check that the intended account appears before asking your agent to report on it. Never paste tokens, client secrets, or private keys into chat.</span></li>
          <li><span class="step-title">Register a local stdio client</span>${cmd('claude mcp add --transport stdio adport -- adport mcp')}<span class="step-text">For Cursor, merge <code>{"mcpServers":{"adport":{"command":"adport","args":["mcp"]}}}</code> into your MCP configuration. ChatGPT uses the HTTP endpoint above instead of launching a local process.</span></li>
        </ol>
        <aside class="p-requirements" aria-labelledby="requirements-title">
          <h3 id="requirements-title">Before you connect</h3>
          <ul>${p.prerequisites.map(text => `<li>${escape(text)}</li>`).join('')}</ul>
          <p class="p-links"><a class="text-link" href="https://github.com/ynnickw/adport/blob/main/${p.guide}">Full ${escape(p.name)} connection guide</a><a class="text-link" href="${p.reference}" rel="noreferrer">Official ${escape(p.name)} API documentation</a></p>
          <p class="p-fineprint">Adport is independent and is not endorsed by ${escape(p.name)}. Provider access and approval are separate from installing this package.</p>
        </aside>
      </div>
    </section>

    <section class="p-section" aria-labelledby="agent-title">
      <div class="section-intro"><h2 id="agent-title">Use ${escape(p.name)} from your agent.</h2></div>
      ${setupTabs(p.name)}
    </section>

    <section class="p-safety" aria-labelledby="safety-title">
      <div><h2 id="safety-title">A suggestion is not a live change.</h2><a class="text-link" href="/#gate">Try the write gate</a></div>
      <div><p>The first mutation call returns a preview and a short-lived pending-operation token. Applying requires that token and the same arguments. Budget caps and protected accounts are checked by the policy engine; new campaigns are paused by policy.</p><p>Local operations are recorded in an append-only audit log. An approved preview is not a guarantee of provider acceptance, and a connected agent does not grant additional account permissions.</p></div>
    </section>

    <section class="p-section p-faq" aria-labelledby="faq-title"><div class="section-intro"><h2 id="faq-title">${escape(p.name)} MCP questions</h2></div>
      <div class="p-faq-list">
        <details open><summary>${escape(p.faq[0])}</summary><p>${escape(p.faq[1])}</p></details>
        <details><summary>Can I use ${escape(p.name)} locally without Adport Cloud?</summary><p>Yes. Install Adport from npm, connect your own ${escape(p.name)} credentials, and register the local MCP server with a stdio-compatible agent such as Claude Code or Cursor. Your provider may have its own approval, access, or billing requirements.</p></details>
        <details><summary>Why can I connect an account but not read a report or apply a change?</summary><p>Account discovery, reporting, and mutations can require different permissions. Check the requested account, provider app scopes, advertiser eligibility, and environment. Start with <code>adport doctor</code> and the connection guide above. Do not bypass a denied operation by sharing secrets with the agent.</p></details>
      </div>
    </section>

    <section class="p-section" aria-labelledby="related-title">
      <div class="p-related-head"><h2 id="related-title">Connect the rest of your ad stack.</h2><a class="text-link" href="/providers">All integrations</a></div>
      <ul class="platform-grid p-directory">${p.related.map(id => card(providers.find(item => item.id === id))).join('')}</ul>
    </section>
    </main>`,
  });
}

const output = new Map(providers.map(p => [`providers/${p.slug}.html`, providerPage(p)]));
output.set('providers.html', document({ title: 'Ads MCP integrations for Claude, Cursor & ChatGPT | Adport', description: 'Explore 11 ad platform MCP integrations. Connect ad accounts to ChatGPT, Claude, Codex, Cursor, and VS Code with Adport MCP.', pathname: '/providers', name: 'Ad integrations', content: `<main class="provider" id="main">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Adport</a><span aria-hidden="true">/</span><span aria-current="page">Integrations</span></nav>
    <section class="p-directory-hero" aria-labelledby="directory-title">
      <h1 id="directory-title">Every ad platform. One agent.</h1>
      <p class="lede">Eleven providers behind one open-source MCP server. Find the setup, capabilities, and reporting details for your platform. Connect ChatGPT, Claude, Codex, Cursor, or VS Code with MCP and OAuth, or run locally with npm for stdio-compatible clients.</p>
    </section>
    <section aria-label="Advertising integrations"><ul class="platform-grid p-directory p-directory-all">${providers.map(card).join('')}<li class="platform-request"><a href="https://github.com/ynnickw/adport/issues" rel="noreferrer"><span class="request-plus" aria-hidden="true"></span><span class="pg-text"><span class="pg-name">Request a platform</span><span class="pg-label">Tell us which ad platform your agent should reach next.</span></span></a></li></ul></section>
    <section class="p-section p-boundary" aria-labelledby="boundary-title">
      <div class="section-intro"><h2 id="boundary-title">One protocol. Platform-specific details.</h2></div>
      <div><p>Each provider has its own account permissions, reporting definitions, API approval process, and supported operations. These guides explain what the connector can do and what you need before connecting. Adport uses the Model Context Protocol (MCP) to expose the same guarded tools to compatible agents.</p><p>Local integrations are included in the npm package. HTTP MCP clients use the same workspace-scoped OAuth connection. No connection method bypasses platform approval.</p></div>
    </section>
  </main>` }));

// Keep existing sitemap entries and add the discoverable provider hierarchy once.
let sitemap = await readFile(path.join(site, 'sitemap.xml'), 'utf8');
sitemap = sitemap.replace(/\s*<url><loc>https:\/\/www\.adport\.dev\/providers(?:\/[^<]+)?<\/loc><\/url>/g, '');
sitemap = sitemap.replace('</urlset>', `  <url><loc>https://www.adport.dev/providers</loc></url>\n${providers.map(p => `  <url><loc>https://www.adport.dev${href(p)}</loc></url>`).join('\n')}\n</urlset>`);
output.set('sitemap.xml', sitemap);

let linkedHome = home.replace(/<!-- agent-setup:start -->[\s\S]*?<!-- agent-setup:end -->/, homeSetup());
for (const p of providers) {
  const svg = logo(p);
  const start = linkedHome.indexOf(svg);
  const liStart = linkedHome.lastIndexOf('<li>', start);
  const liEnd = linkedHome.indexOf('</li>', start);
  const item = linkedHome.slice(liStart, liEnd + 5);
  if (!item.includes('<a ')) linkedHome = linkedHome.replace(item, `<li><a href="${href(p)}">${item.slice(4, -5)}</a></li>`);
}
output.set('index.html', linkedHome);

let stale = false;
for (const [file, content] of output) {
  const target = path.join(site, file);
  const current = await readFile(target, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current === content) continue;
  if (check) { console.error(`Out of date: website/${file}`); stale = true; continue; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
if (stale) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Generated'} ${providers.length} provider pages, directory, homepage links, and sitemap.`);

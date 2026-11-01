export const sources = {
  mcp: { title: 'Model Context Protocol: server concepts', url: 'https://modelcontextprotocol.io/docs/learn/server-concepts' },
  auth: { title: 'MCP authorization specification', url: 'https://modelcontextprotocol.io/specification/latest/basic/authorization' },
  claude: { title: 'Claude Code: connect tools with MCP', url: 'https://code.claude.com/docs/en/mcp' },
  chatgpt: { title: 'OpenAI: add a custom MCP server', url: 'https://developers.openai.com/api/docs/guides/custom-mcp-server' },
  codex: { title: 'OpenAI: MCP configuration', url: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli' },
  negatives: { title: 'Google Ads: negative keyword matching', url: 'https://support.google.com/google-ads/answer/2453972?hl=en' },
  terms: { title: 'Google Ads: find negatives in search terms', url: 'https://support.google.com/google-ads/answer/7102466?hl=en' },
  lag: { title: 'Google Ads: conversion lag reporting', url: 'https://support.google.com/google-ads/answer/9347141?hl=en' },
  learning: { title: 'Google Ads: bid strategy learning periods', url: 'https://support.google.com/google-ads/answer/13020501?hl=en' },
  budget: { title: 'Google Ads: average daily budgets', url: 'https://support.google.com/google-ads/answer/6385083?hl=en' },
  limits: { title: 'Google Ads: spending limits', url: 'https://support.google.com/google-ads/answer/10486637?hl=en' },
  access: { title: 'Google Ads: manager account access levels', url: 'https://support.google.com/google-ads/answer/9977851?hl=en' },
  values: { title: 'Google Ads: conversion values', url: 'https://support.google.com/google-ads/answer/13064207?hl=en' },
  bidding: { title: 'Google Ads: bidding objectives', url: 'https://support.google.com/google-ads/answer/10969287?hl=en' },
};
export const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const cite = (id, label = sources[id].title) => `<a href="${escape(sources[id].url)}" rel="noreferrer">${escape(label)}</a>`;
export const prompt = text => `<div class="guide-prompt"><div><span>Try this prompt</span><button class="text-action copy-chip" type="button" data-copy-command="${escape(text)}"><span class="copy-label" aria-live="polite">Copy prompt</span></button></div><blockquote>${escape(text)}</blockquote></div>`;
export const code = text => `<pre class="guide-code"><code>${escape(text)}</code></pre>`;
export const section = (id, title, html) => ({ id, title, html });

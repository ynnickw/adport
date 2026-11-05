import { MEDIA_LIBRARY_UI, MEDIA_LIBRARY_STYLES } from './media-library-ui.js';
import { MEDIA_UPLOAD_UI } from './media-upload-ui.js';
import { TREND_UI_SCRIPT, TREND_UI_STYLES } from './trend-ui.js';
import { RECORD_UI_SCRIPT, RECORD_UI_STYLES } from './record-ui.js';
import { RECEIPT_UI_SCRIPT, RECEIPT_UI_STYLES } from './receipt-ui.js';
import { INSIGHT_UI_SCRIPT, INSIGHT_UI_STYLES } from './insight-ui.js';
import { CREATIVE_UI_SCRIPT, CREATIVE_UI_STYLES } from './creative-ui.js';
import { PROVIDER_GALLERY_UI, PROVIDER_GALLERY_STYLES } from './provider-gallery-ui.js';
import { PROVIDER_LOGOS } from './provider-logos.js';
import { OPERATION_UI_SCRIPT } from './operation-ui.js';
import { APPLE_REPORT_UI_SCRIPT, APPLE_REPORT_UI_STYLES } from './apple-report-ui.js';
import { NATIVE_REPORT_UI_SCRIPT, NATIVE_REPORT_UI_STYLES } from './native-report-ui.js';

export const ADPORT_UI_URI = 'ui://adport/insight-card-v22.html';
export const ADPORT_UI_DOMAIN = 'https://app.adport.dev';
export const ADPORT_UI_RESOURCE_DOMAINS = [ADPORT_UI_DOMAIN, 'https://*.fbcdn.net', 'https://*.fbsbx.com', 'https://*.googleusercontent.com', 'https://tpc.googlesyndication.com', 'https://www.bing.com', 'https://*.scdn.co', 'https://*.spotifycdn.com', 'https://storage.googleapis.com', 'https://*.pinimg.com', 'https://*.redd.it', 'https://*.redditmedia.com', 'https://*.redditstatic.com', 'https://*.licdn.com', 'https://*.licdn-ei.com', 'https://pbs.twimg.com', 'https://video.twimg.com', 'https://ton.twimg.com'];

export type AdportView = 'accounts' | 'report' | 'operation' | 'insights' | 'creatives' | 'planning' | 'data' | 'records' | 'receipt';

const providerNames: Record<string, string> = {
  google: 'Google Ads',
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  apple: 'Apple Ads',
  microsoft: 'Microsoft Advertising',
  reddit: 'Reddit Ads',
  snapchat: 'Snapchat Ads',
  spotify: 'Spotify Ads',
  pinterest: 'Pinterest Ads',
  linkedin: 'LinkedIn Ads',
  x: 'X Ads',
  mock: 'Demo',
  demo: 'Synthetic demo',
};

export function viewForTool(name: string, readOnly: boolean): AdportView {
  if (name === 'accounts_list') return 'accounts';
  if (name === 'report') return 'report';
  if (name === 'audit_run' || name === 'recommendation_dismiss') return 'insights';
  if (!readOnly) return 'operation';
  if (name.startsWith('recommendation') || name.startsWith('audit_')) return 'insights';
  if (/(?:_request_status|_upload_status|_experiment_operation|_offline_conversion_diagnostics|_get_media_upload)$/.test(name)) return 'receipt';
  return 'data';
}

export function toolTitle(name: string): string {
  if (name === 'accounts_list') return 'Show connected ad accounts';
  if (name === 'report') return 'Show advertising performance';
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function toolInvocationLabels(view: AdportView): { invoking: string; invoked: string } {
  switch (view) {
    case 'accounts': return { invoking: 'Loading ad accounts…', invoked: 'Ad accounts ready' };
    case 'report': return { invoking: 'Analyzing performance…', invoked: 'Performance ready' };
    // Descriptor labels cover both preview and apply; the card shows the actual result.
    case 'operation': return { invoking: 'Processing change…', invoked: 'Change result ready' };
    case 'insights': return { invoking: 'Reviewing opportunities…', invoked: 'Opportunities ready' };
    case 'creatives': return { invoking: 'Loading creatives…', invoked: 'Creatives ready' };
    case 'planning': return { invoking: 'Loading planning estimates…', invoked: 'Planning estimates ready' };
    case 'records': return { invoking: 'Loading records…', invoked: 'Records ready' };
    case 'receipt': return { invoking: 'Checking processing…', invoked: 'Processing status ready' };
    case 'data': return { invoking: 'Loading data…', invoked: 'Data ready' };
  }
}

export function structuredResult(tool: string, view: AdportView, result: unknown, approval?: { arguments: Record<string, unknown> }, context?: { project_id: string }, capabilities?: { can_write: boolean }, refresh?: { arguments: Record<string, unknown> }, next?: { arguments: Record<string, unknown> }, descriptor?: { provider?: string; accountId?: string; pagination?: { cursorInput: string } }): Record<string, unknown> {
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { value: result };
  return {
    ...payload,
    _adport: {
      tool,
      view,
      providerNames,
      ...descriptor,
      ...(approval ? { approval } : {}),
      ...(context ? { context } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(refresh ? { refresh } : {}),
      ...(next ? { next } : {}),
    },
  };
}

/**
 * Self-contained MCP App. It uses the open MCP Apps postMessage protocol and
 * has no external script dependencies. Media uses only the resource CSP supplied
 * by the server; tool invocations always use the host bridge.
 */
export const ADPORT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Adport insight</title>
  <style>
    :root {
      --ink: var(--color-text-primary, #171717);
      --muted: var(--color-text-secondary, #6f6f73);
      --faint: var(--color-text-tertiary, #949499);
      --paper: var(--color-background-primary, #ffffff);
      --soft: var(--color-background-secondary, #f6f6f4);
      --line: var(--color-border-secondary, rgba(23,23,23,.11));
      --orange: #ff6b00;
      --green: #16845b;
      --red: #c8392f;
      --amber: #a86500;
      --radius: var(--border-radius-lg, 18px);
      --sans: var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    * { box-sizing: border-box }
    html, body { margin: 0; min-width: 0; background: transparent; color: var(--ink); font-family: var(--sans) }
    body { padding: 2px; }
    button { font: inherit }
    .shell { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 32px rgba(20,20,20,.07) }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 16px 10px }
    .brand { display:flex; align-items:center; gap:9px; min-width:0 }
    .wordmark-dot { color:#ff6b00; font-size:1.3em; line-height:0 }
    .brand b { font-size:12px; letter-spacing:-.02em }
    .context { color:var(--muted); font-size:11px; text-align:right }
    .content { padding:4px 16px 16px }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:15px }
    .kpi { min-width:0; padding:12px; border-radius:13px; background:var(--soft); border:1px solid color-mix(in srgb,var(--line) 70%,transparent) }
    button.kpi { cursor:pointer; color:var(--ink); text-align:left }
    button.kpi[aria-pressed="true"] { border-color:color-mix(in srgb,var(--orange) 65%,var(--line)) }
    .kpi small { display:block; color:var(--faint); font:600 9px/1.2 var(--mono); letter-spacing:.11em; text-transform:uppercase }
    .kpi strong { display:block; overflow:hidden; margin-top:8px; font-size:clamp(17px,3vw,24px); line-height:1; letter-spacing:-.04em; text-overflow:ellipsis }
    .panel { min-width:0; padding:13px; border:1px solid var(--line); border-radius:14px }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px }
    .panel-head b { font-size:12px }
    .panel-head span { color:var(--faint); font:500 9px/1 var(--mono); text-transform:uppercase; letter-spacing:.1em }
    .bars { display:grid; gap:9px }
    .bar-row { display:grid; grid-template-columns:minmax(100px,1fr) minmax(60px,2fr) auto; align-items:center; gap:9px; font-size:11px }
    .bar-name { display:flex; align-items:center; gap:7px; min-width:0 }
    .bar-name > span:last-child { overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .bar-name .logo { width:22px; height:22px; padding:4px; border-radius:6px }
    .track { height:7px; overflow:hidden; border-radius:99px; background:var(--soft) }
    .fill { height:100%; border-radius:99px; background:linear-gradient(90deg,var(--orange),#ff985e) }
    .tabs { display:flex; gap:6px; overflow:auto; padding-bottom:12px }
    .tabs button { flex:0 0 auto; cursor:pointer; padding:8px 12px; border:1px solid var(--line); border-radius:99px; background:var(--paper); color:var(--muted); font-size:12px }
    .tabs button[aria-pressed="true"] { color:var(--ink); border-color:var(--orange); background:color-mix(in srgb,var(--orange) 8%,var(--paper)) }
    button:focus-visible { outline:2px solid var(--orange); outline-offset:2px }
    .notice { padding:10px 12px; margin:0 0 12px; border-radius:10px; background:var(--soft); color:var(--muted); font-size:12px; line-height:1.45 }
    .bar-value { color:var(--muted); font:600 10px/1 var(--mono); white-space:nowrap }
    .list { display:grid; gap:7px }
    .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 11px; border:1px solid var(--line); border-radius:12px }
    .identity { display:flex; align-items:center; gap:10px; min-width:0 }
    .logo { display:grid; place-items:center; flex:0 0 auto; width:29px; height:29px; padding:6px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:var(--paper); font-weight:800; font-size:10px }
    .logo svg { display:block; width:100%; height:100% }
    .logo.reddit { background:#ff4500 }.logo.linkedin { background:#0a66c2 }.logo.spotify { background:#1db954 }.logo.pinterest { background:#e60023 }.logo.x { background:#111 }.logo.snapchat { background:#fffc00;color:#111 }
    .identity-copy { min-width:0 }
    .identity-copy b, .identity-copy span { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .identity-copy b { font-size:12px }.identity-copy span { margin-top:3px; color:var(--muted); font-size:10px }
    .pill { flex:0 0 auto; padding:5px 8px; border-radius:99px; color:var(--green); background:color-mix(in srgb,var(--green) 10%,transparent); font:700 9px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase }
    .pill.warn { color:var(--amber); background:color-mix(in srgb,var(--amber) 11%,transparent) }
    .pill.danger { color:var(--red); background:color-mix(in srgb,var(--red) 10%,transparent) }
    .pill.neutral { color:var(--muted); background:var(--soft) }
    .operation-name { margin:2px 0 16px; font-size:14px; line-height:1.4; font-weight:600; overflow-wrap:anywhere }
    .comparison { width:100%; border-collapse:collapse; table-layout:fixed; margin-bottom:12px }
    .comparison th { padding:0 8px 8px; color:var(--muted); font-size:10px; font-weight:500; text-align:left }
    .comparison td { border-top:1px solid var(--line); padding:12px 8px; font-size:14px; overflow-wrap:anywhere }
    .comparison td:first-child { color:var(--muted); font-size:11px }
    .comparison td:last-child { font-weight:600 }
    .comparison .changed { color:var(--orange) }
    .planning-scroll { max-height:440px; overflow:auto; margin-bottom:12px }
    .planning-table { width:100%; border-collapse:collapse; font-size:11px }
    .planning-table th { position:sticky; top:0; background:var(--paper); padding:8px; text-align:left; color:var(--muted) }
    .planning-table td { border-top:1px solid var(--line); padding:9px 8px; overflow-wrap:anywhere }
    .planning-pages { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px }
    .planning-pages button { cursor:pointer; padding:7px 10px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:var(--paper) }
    .planning-pages button:disabled { cursor:default; opacity:.45 }
    .adjustment { margin:8px 0; color:var(--amber); font-size:11px; line-height:1.4 }
    .approval { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:12px 0 }
    .approve { cursor:pointer; min-width:145px; padding:11px 19px 10px; border:0; border-radius:999px; background:var(--orange); color:#1d1d1f; font-size:13px; font-weight:750 }
    .approve:disabled { cursor:default; opacity:.55 }
    .approve { position:relative; overflow:hidden; touch-action:none; user-select:none }
    .approve::before { content:''; position:absolute; inset:0; background:#1d1d1f26; transform:scaleX(0); transform-origin:left }
    .approve > span { position:relative }
    @media (hover:hover) { .approve:not(:disabled):hover { background:#f26100 } }
    .approve.holding::before { transform:scaleX(1); transition:transform .9s linear }
    .approve:focus-visible { outline:2px solid var(--orange); outline-offset:3px }
    @media (prefers-reduced-motion:reduce) { .approve.holding::before { transition:none } }
    details { border-top:1px solid var(--line); padding-top:10px; color:var(--muted); font-size:11px; line-height:1.5 }
    summary { cursor:pointer; width:fit-content; padding:3px 0 }
    summary:focus-visible { outline:2px solid var(--orange); outline-offset:3px }
    details p { margin:8px 0; overflow-wrap:anywhere }
    .empty { padding:26px 12px; text-align:center; color:var(--muted); font-size:12px }
    .operation-heading { display:flex; align-items:center; gap:11px; margin:8px 0 22px; min-width:0 }
    .operation-heading h2 { margin:0; font-size:15px; line-height:1.4; font-weight:650; letter-spacing:-.015em }
    .operation-heading p { margin:3px 0 0; color:var(--muted); font-size:12px; overflow-wrap:anywhere }
    .review-fields { margin:0; display:grid; gap:12px }
    .review-field { display:grid; grid-template-columns:minmax(90px,.8fr) minmax(0,2fr); gap:12px; align-items:baseline }
    .review-field dt { font-size:12px; color:var(--muted); overflow-wrap:anywhere }
    .review-field dd { display:flex; flex-wrap:wrap; align-items:baseline; gap:5px 9px; margin:0; min-width:0; font-size:14px; overflow-wrap:anywhere }
    .review-before,.review-arrow,.unavailable { color:var(--muted) }
    .review-after { font-weight:500; min-width:0 }
    .review-copy { font-size:16px!important; line-height:1.6 }
    .review-money { font-size:20px!important; font-variant-numeric:tabular-nums }
    .review-list { margin:0; padding-left:17px; display:grid; gap:5px }
    .review-added,.review-removed { padding:3px 7px; border-radius:5px; font-size:13px }
    .review-added { color:var(--green); background:color-mix(in srgb,var(--green) 10%,var(--paper)) }
    .review-removed { color:var(--red); background:color-mix(in srgb,var(--red) 10%,var(--paper)) }
    .operation-note { margin:10px 0; color:var(--muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere }
    .operation-footer { position:relative; border-top:1px solid var(--line); margin-top:21px; padding-top:14px; min-height:55px }
    .operation-footer > details { border:0; padding:0 }
    .operation-footer summary { display:flex; align-items:center; min-height:40px; max-width:calc(100% - 160px); padding:0 }
    .operation-footer summary::after { content:'⌄'; margin-left:5px }
    .operation-action { position:absolute; top:14px; right:0 }
    .operation-status { display:block; padding:11px 0; font-size:13px }
    .operation-details { padding-top:12px }
    .operation-details .review-fields { margin:14px 0 }
    pre { font:11px/1.5 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; margin:12px 0 0 }
    .data-record { padding:12px 0; border-top:1px solid var(--line) }
    @media (max-width:420px) { .review-field { grid-template-columns:1fr; gap:5px } }
    @media (pointer:coarse) { .approve,.operation-footer summary { min-height:44px } }
    @media (max-width:620px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)) }.top,.content { padding-left:12px; padding-right:12px } }
    @media (max-width:420px) { .bar-row { grid-template-columns:minmax(0,1fr) auto; gap:5px }.bar-name { grid-column:1/-1 }.bar-name > span:last-child { white-space:normal }.bars { gap:12px } }
${CREATIVE_UI_STYLES}
${PROVIDER_GALLERY_STYLES}
${MEDIA_LIBRARY_STYLES}
${RECORD_UI_STYLES}
${APPLE_REPORT_UI_STYLES}
${NATIVE_REPORT_UI_STYLES}
${RECEIPT_UI_STYLES}
${INSIGHT_UI_STYLES}
${TREND_UI_STYLES}
    @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important } }
    :root[data-theme="dark"] { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) }
    @media (prefers-color-scheme:dark) { :root:not([data-theme="light"]) { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) } }
  </style>
</head>
<body>
  <main id="app" class="shell" aria-live="polite">
    <header class="top"><div class="brand"><b>adport<span class="wordmark-dot" aria-hidden="true">.</span></b></div></header>
    <section class="content"><div class="empty">Loading…</div></section>
  </main>
  <script>
  (() => {
    const app = document.getElementById('app');
    const state = { host: {}, result: null, reportGroup: null, reportMetric: 'spend', planningPage: 0, hasLocalResult: false };
    const hostResults=new Set();
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const arr = (value) => Array.isArray(value) ? value : [];
    const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    const money = (value, currency, maximumFractionDigits=2) => currency
      ? new Intl.NumberFormat(state.host.locale || 'en', { style:'currency', currency, maximumFractionDigits }).format(num(value))
      : new Intl.NumberFormat(state.host.locale || 'en', { maximumFractionDigits }).format(num(value));
    const compact = (value) => new Intl.NumberFormat(state.host.locale || 'en', { notation:'compact', maximumFractionDigits:1 }).format(num(value));
    const available = (value) => typeof value === 'number' && Number.isFinite(value);
    const total = (rows, key) => rows.length && rows.every(r => available(r.metrics?.[key])) ? rows.reduce((sum,r) => sum+r.metrics[key],0) : null;
    const rowReturn = (row) => {
      const m=row.metrics || {};
      if (available(m.conversion_value)) return m.conversion_value;
      // A report can request ROAS without conversion_value. Weight reported
      // ratios by spend; never average campaign ratios or infer missing revenue.
      const value=available(m.spend) && m.spend>0 && available(m.roas) ? m.spend*m.roas : null;
      return available(value) ? value : null;
    };
    const currencyOf = (row) => typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
    const statusOf = (status) => !status || /unknown|unspecified/i.test(status) ? {label:'Status unavailable',tone:'neutral'} : /disabled|removed|inactive|closed|suspended/i.test(status) ? {label:status,tone:'danger'} : /paused|disable$/i.test(status) ? {label:status,tone:'warn'} : /^(enabled|active|approved|ready)$/i.test(status) ? {label:status,tone:''} : {label:status,tone:'neutral'};
    const noticeText=(value,fallback)=>typeof value==='string'?value:typeof value?.message==='string'?value.message:typeof value?.reason==='string'?value.reason:fallback;
    const notices = data => [...arr(data.errors).map(error=>(error?.provider || 'Provider')+': '+noticeText(error,'Read failed')), ...arr(data.warnings).map(warning=>noticeText(warning,'Some metadata is unavailable')), ...arr(data.notes).filter(note=>typeof note==='string'), ...(typeof data.note==='string'?[data.note]:[]), ...(data.truncated ? ['Partial result: row limit reached. Totals and charts cover returned rows only.'] : [])].map(text => '<p class="notice">'+esc(text)+'</p>').join('');
    const providerName = (id, names) => names?.[id] || String(id || 'Provider');
    const initials = (id) => ({snapchat:'S',spotify:'S',pinterest:'P',linkedin:'in',x:'X'}[id] || String(id || '?').slice(0,2).toUpperCase());
    const providerSvg = ${JSON.stringify(PROVIDER_LOGOS)};
    const logo = (id) => '<span class="logo '+esc(id)+'" aria-hidden="true">'+(providerSvg[id] || esc(initials(id)))+'</span>';
    let syntheticResult = false;
    const chrome = (body, context) => '<header class="top"><div class="brand"><b>adport<span class="wordmark-dot" aria-hidden="true">.</span></b></div><span class="context">'+(syntheticResult?'Synthetic demo · ':'')+esc(context || '')+'</span></header><section class="content">'+body+'</section>';
    function renderAccounts(data, meta) {
      const accounts = arr(data.accounts), errors = arr(data.errors), names = meta.providerNames || {};
      const body = notices(data)+(accounts.length ? '<div class="list">'+accounts.map(a => { const status=statusOf(a.status); return '<div class="row"><div class="identity">'+logo(a.provider)+'<div class="identity-copy"><b>'+esc(a.name || 'Ad account')+'</b><span>'+esc(providerName(a.provider,names))+' · '+esc(a.id)+(a.currency ? ' · '+esc(a.currency) : '')+'</span></div></div><span class="pill '+status.tone+'">'+esc(status.label)+'</span></div>'; }).join('')+'</div>' : '<div class="empty">'+(errors.length ? 'Account inventory could not be fully loaded.' : 'No accessible ad accounts were returned.')+'</div>');
      app.innerHTML = chrome(body, accounts.length+' account'+(accounts.length===1?'':'s'));
    }
    function renderReport(data,meta) {
      const groups = new Map();
      for (const row of arr(data.rows)) {
        const currency=currencyOf(row), key=currency || JSON.stringify([row.provider,row.accountId]);
        if (!groups.has(key)) groups.set(key,{key,currency,label:currency || (row.provider+' · '+row.accountId),rows:[]});
        groups.get(key).rows.push(row);
      }
      const choices=[...groups.values()];
      const selected=groups.get(state.reportGroup) || choices[0];
      const rows=selected?.rows || [], currency=selected?.currency;
      state.reportGroup=selected?.key;
      const tabs=choices.length>1 ? '<div class="tabs" role="group" aria-label="Report currency or account">'+choices.map((g,i)=>'<button data-group="'+i+'" aria-pressed="'+(g===selected)+'">'+esc(g.label)+'</button>').join('')+'</div>' : '';
      const summary=arr(data.summary?.groups).find(group=>group.key===selected?.key)?.metrics;
      const aggregate=key=>summary ? (available(summary[key])?summary[key]:null) : total(rows,key);
      const spend=aggregate('spend'), returns=rows.map(rowReturn);
      const value=returns.length && returns.every(available) ? returns.reduce((sum,value)=>sum+value,0) : null;
      const ratio=summary ? summary.roas : spend>0 && value!==null ? value/spend : null;
      const roas=available(ratio) ? ratio.toFixed(2)+'×' : '—';
      const metric=state.reportMetric, labels={spend:'Spend',clicks:'Clicks',conversions:'Conversions',roas:'ROAS'};
      const metricValue=r=>metric==='roas' ? (available(r.metrics?.conversion_value) && r.metrics?.spend>0 ? r.metrics.conversion_value/r.metrics.spend : r.metrics?.roas) : r.metrics?.[metric];
      const format=value=>metric==='spend'?money(value,currency):metric==='roas'?value.toFixed(2)+'×':compact(value);
      const ranked=[...rows].filter(r=>available(metricValue(r))).sort((a,b)=>metricValue(b)-metricValue(a)).slice(0,6), max=Math.max(1,...ranked.map(metricValue));
      const bars=ranked.length ? ranked.map(r=>'<div class="bar-row"><span class="bar-name" title="'+esc(r.entity?.name || r.entity?.id)+'">'+logo(r.provider)+'<span>'+esc(r.entity?.name || r.entity?.id || 'Entity')+'</span></span><span class="track" aria-hidden="true"><span class="fill" style="display:block;width:'+Math.max(0,metricValue(r)/max*100).toFixed(1)+'%"></span></span><span class="bar-value">'+esc(format(metricValue(r)))+'</span></div>').join('') : '<div class="empty">No '+esc(labels[metric])+' values were returned.</div>';
      const kpi=(key,label,value)=>'<button class="kpi" data-metric="'+key+'" aria-pressed="'+(metric===key)+'" aria-label="Chart '+esc(label)+'"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong></button>';
      const period=typeof data.date_range==='string' ? data.date_range.replaceAll('_',' ') : data.date_range ? data.date_range.start+' – '+data.date_range.end : 'Selected period';
      const dated=rows.some(row=>typeof row.date==='string');
      const chart=dated?'<div class="report-trend"><div class="panel-head"><b>Daily '+esc(labels[metric].toLowerCase())+'</b>'+providerMarks(rows.map(row=>row.provider),meta,'Report platforms')+'</div><div data-report-trend></div><p class="operation-note">Missing or unavailable days remain gaps.</p></div>':'<div class="panel"><div class="panel-head"><b>'+esc(labels[metric])+'</b><span>Top '+ranked.length+' of '+rows.length+' rows</span></div><div class="bars">'+bars+'</div></div>';
      const body=notices(data)+tabs+(rows.length ? (!currency?'<p class="notice">Currency unavailable. These values belong to this account only; no cross-account money total is calculated.</p>':'')+'<div class="kpis" role="group" aria-label="Chart metric">'+kpi('spend','Spend',spend===null?'—':money(spend,currency))+kpi('clicks','Clicks',total(rows,'clicks')===null?'—':compact(total(rows,'clicks')))+kpi('conversions','Conversions',total(rows,'conversions')===null?'—':compact(total(rows,'conversions')))+kpi('roas','ROAS',roas)+'</div>'+chart : '<div class="empty">'+(arr(data.errors).length?'Report unavailable for the requested providers.':'No rows returned for this period.')+'</div>');
      trendResize?.disconnect();
      app.innerHTML=chrome(body,period+(currency?' · '+currency:''));
      if(dated)mountReportTrend(rows,metric,currency,data);
      app.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{state.reportGroup=choices[Number(button.dataset.group)].key;renderReport(data,meta);}));
      app.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{state.reportMetric=button.dataset.metric;renderReport(data,meta);}));
    }
${OPERATION_UI_SCRIPT}
${RECEIPT_UI_SCRIPT}
${RECORD_UI_SCRIPT}
${APPLE_REPORT_UI_SCRIPT}
${NATIVE_REPORT_UI_SCRIPT}
${INSIGHT_UI_SCRIPT}
${TREND_UI_SCRIPT}
    async function callTool(tool,parameters,timeoutMs=30000) {
      const requestId=id++;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pendingRequests.delete(requestId);reject(new Error('The request could not be confirmed. Check the result in chat before retrying.'));},timeoutMs);
        pendingRequests.set(requestId,{resolve,reject,timer});
        if (typeof window.openai?.callTool==='function') {
          Promise.resolve().then(()=>window.openai.callTool(tool,parameters)).then(result=>{
            const request=pendingRequests.get(requestId);if (request) {clearTimeout(request.timer);pendingRequests.delete(requestId);request.resolve(result);}
          },error=>{const request=pendingRequests.get(requestId);if (request) {clearTimeout(request.timer);pendingRequests.delete(requestId);request.reject(error);}});
        } else send({jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:tool,arguments:parameters}});
      });
    }
${MEDIA_UPLOAD_UI}
${MEDIA_LIBRARY_UI}
${CREATIVE_UI_SCRIPT}
${PROVIDER_GALLERY_UI}
    function renderPlanning(data,meta) {
      const planning=data.planning || {}, columns=arr(planning.columns).filter(v=>typeof v?.key==='string'&&typeof v?.label==='string').slice(0,12), rows=arr(planning.rows), pageSize=100, pages=Math.max(1,Math.ceil(rows.length/pageSize));
      state.planningPage=Math.max(0,Math.min(state.planningPage,pages-1));
      const start=state.planningPage*pageSize, shown=rows.slice(start,start+pageSize);
      const notes=arr(planning.notes).filter(v=>typeof v==='string').map(v=>'<p class="notice">'+esc(v)+'</p>').join('');
      const table=columns.length&&shown.length?'<div class="planning-scroll" tabindex="0" role="region" aria-label="Planning estimate table"><table class="planning-table"><thead><tr>'+columns.map(v=>'<th scope="col">'+esc(v.label)+'</th>').join('')+'</tr></thead><tbody>'+shown.map(row=>'<tr>'+columns.map(column=>{const value=row&&Object.hasOwn(row,column.key)?row[column.key]:null;return '<td>'+esc(value==null?'—':value)+'</td>';}).join('')+'</tr>').join('')+'</tbody></table></div>':'<div class="empty">No planning values were returned for this selection.</div>';
      const controls=pages>1?'<div class="planning-pages"><button type="button" data-planning-page="previous" '+(state.planningPage===0?'disabled':'')+'>Previous rows</button><span class="context">Rows '+(start+1)+'–'+(start+shown.length)+' of '+rows.length+'</span><button type="button" data-planning-page="next" '+(state.planningPage===pages-1?'disabled':'')+'>Next rows</button></div>':'';
      app.innerHTML=chrome(operationHeader(planning.title || 'Planning estimates','',meta.provider)+table+controls+(data.truncated?'<p class="notice">Partial native response. More estimates may exist.</p>':'')+notes,'Read-only estimates');
      app.querySelectorAll('[data-planning-page]').forEach(button=>button.addEventListener('click',()=>{if(button.disabled)return;state.planningPage+=button.dataset.planningPage==='next'?1:-1;renderPlanning(data,meta);}));
    }
    function render(result) {
      cancelHold();clearTimeout(expiryTimer);trendResize?.disconnect();
      let data=resultData(result);
      if (!object(data)) data={value:data};
      const meta = data._adport || {};
      recordPages=null;
      if(providerGallery && meta.view!=='creatives' && (!providerGallery.review || meta.view!=='operation' || meta.tool!==providerGallery.review.tool || meta.accountId!==providerGallery.meta.accountId || meta.context?.project_id!==providerGallery.meta.context?.project_id)) providerGallery=null;
      syntheticResult = data.data_source === 'synthetic';
      if (data.cancelled) {
        app.innerHTML=chrome('<p class="notice">'+esc(data.message || 'The host interrupted this request. Check the tool response before retrying.')+'</p>','Request interrupted');
        return;
      }
      if (result?.isError || data.error) {
        renderFailure(data,meta,meta.view==='operation');
        return;
      }
      if (meta.view === 'accounts') return renderAccounts(data,meta);
      if (meta.view === 'report') return renderReport(data,meta);
      if (meta.view === 'operation') {renderOperation(data,meta);providerGalleryReviewControls(data,meta);return;}
      if (meta.view === 'records') return renderRecords(data,meta);
      if (meta.view === 'receipt') return renderReceipt(data,meta);
      if (meta.view === 'creatives') return renderCreatives(data,meta);
      if (meta.view === 'planning') return renderPlanning(data,meta);
      if (meta.view === 'insights') return renderInsights(data,meta);
      return renderData(data,meta);
    }
    function acceptResult(result,local=false) {
      if (!result || typeof result !== 'object') return;
      const incoming=resultData(result);
      if(!local && (providerGalleryIgnoreEcho(incoming) || mediaLibraryIgnoreEcho(incoming) || recordPagesIgnoreEcho(incoming))) return;
      if(!local && (app.querySelector('[data-media-gallery]') && uploads.items.length>0 && ['media_prepare_upload','media_finalize_upload','media_get'].includes(incoming?._adport?.tool || result._meta?.adport?.tool) || mediaLibrary?.loading && incoming?._adport?.tool==='media_list' && mediaLibraryProject(incoming,incoming._adport)===mediaLibrary.project)) return;
      const fingerprint=JSON.stringify(incoming);
      // Host state updates can echo an old tool result after a local edit/apply.
      if (!local && state.hasLocalResult && hostResults.has(fingerprint)) return;
      if (local) state.hasLocalResult=true;
      else {hostResults.add(fingerprint);if (hostResults.size>16) hostResults.delete(hostResults.values().next().value);}
      clearTimeout(resultWait);
      // ChatGPT can deliver the same result through both supported bridges.
      // Do not reset an open disclosure when the second copy arrives.
      if (state.result && JSON.stringify(state.result) === JSON.stringify(result)) return;
      state.planningPage=0;
      state.result = result;
      render(result);
    }
    function receiveGlobals(globals) {
      if (!globals) return;
      const metadata = globals.toolResponseMetadata;
      const envelope = metadata?.mcp_tool_result || metadata?.call_tool_result;
      if (envelope && typeof envelope === 'object') return acceptResult(envelope);
      if (globals.toolOutput && typeof globals.toolOutput === 'object') acceptResult({structuredContent:{...globals.toolOutput,...(metadata?.adport?{_adport:metadata.adport}:{})}});
    }
    // Some hosts mount an error result's resource but never relay its payload.
    // This is a delivery fallback, not a claim about tool execution or success.
    const resultWait = setTimeout(() => {
      if (!state.result) app.innerHTML=chrome('<p class="notice">The host has not provided a result to this view. Check the tool response in the conversation. This card will update if a result arrives.</p>','Result not received');
    }, 15000);
    const send = (message) => window.parent.postMessage(message,'*');
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:Math.ceil(document.body.getBoundingClientRect().height)}});
    });
    let id = 1;
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (message.id !== undefined && pendingRequests.has(message.id)) {
        const request=pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(message.error);
        else request.resolve(message.result);
        return;
      }
      if (message.id === 1 && message.result) {
        state.host = message.result.hostContext || {};
        document.documentElement.dataset.theme = state.host.theme || '';
        send({jsonrpc:'2.0',method:'ui/notifications/initialized'});
        resize?.observe(document.body);
        if (state.result) render(state.result);
      }
      if (message.method === 'ui/notifications/tool-result') acceptResult(message.params);
      if (message.method === 'ui/notifications/tool-cancelled') acceptResult({structuredContent:{cancelled:true,message:message.params?.reason}});
      if (message.method === 'ui/notifications/host-context-changed') {
        const previousLocale = state.host.locale;
        state.host = {...state.host,...message.params};
        document.documentElement.dataset.theme = state.host.theme || '';
        // Size/theme updates must not rebuild the DOM: opening Details changes
        // the iframe height, which some hosts echo back as a context update.
        if (state.result && previousLocale !== state.host.locale) {
          const expanded = app.querySelector('details')?.open || false;
          render(state.result);
          const details = app.querySelector('details');
          if (details) details.open = expanded;
        }
      }
    });
    // The compatibility bridge can hydrate after the iframe has mounted,
    // including full error envelopes in toolResponseMetadata.
    window.addEventListener('openai:set_globals', event => receiveGlobals(event.detail?.globals));
    send({jsonrpc:'2.0',id:id++,method:'ui/initialize',params:{appInfo:{name:'Adport Insight',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'}});
    receiveGlobals(window.openai);
  })();
  </script>
</body>
</html>`;

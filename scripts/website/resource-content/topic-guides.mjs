import { cite, code, prompt, section } from './shared.mjs';
import { agentSetups, CHATGPT_PLUGIN_URL, mcpBaseUrl } from '../website-agent-setups.mjs';

export const topicContentDate = '2026-11-28';

export const topicGuides = {
  'matomo-analytics': {
    title: 'Matomo campaign analytics and goal tracking for marketing teams',
    marks: ['matomo'],
    sections: [
      section('campaign-report', 'How to track a marketing campaign in Matomo', `<p>Give every link in a campaign the same campaign name and a source and medium that describe where that particular link runs. For a spring demo offer in a customer newsletter, use a tagged link like the one below.</p>
        ${code('https://example.com/demo?mtm_campaign=spring-demo&mtm_source=customer-newsletter&mtm_medium=email')}
        <p>Send the link through your normal email or ad preview. Follow it to the final page and check that the redirect preserves the tags. Open <strong>Acquisition → Campaigns</strong> in the correct Matomo site and look for <code>spring-demo</code> in the reporting period. The same campaign on paid search should carry its own source and medium. This gives you a way to compare the two placements even when both land on <code>/demo</code>.</p>
        <p>Matomo core records the campaign name and keyword. Matomo Cloud and installations with Marketing Campaigns Reporting can also record source and medium. An older archive can contain the name without the full combination. Keep those visits in a separate row when calculating channel totals. ${cite('matomoTags', 'Matomo’s guide to campaign parameters')}.</p>`),
      section('read-goal', 'Choose one conversion goal before comparing landing pages', `<p>In <strong>Goals</strong>, find the action your team actually values. A visitor opening the contact page and a visitor completing the demo form answer different questions. Record the completion goal’s ID and whether it can fire more than once per visit. In Adport, connect your instance under <strong>Analytics &amp; tracking → Add source → Matomo</strong>, select the site and enable it for your assistant. A local CLI connection can reach an installation on a private network.</p>
        ${prompt('List the enabled Matomo sites and their IDs. For my chosen site, show the goals. After I select the demo completion goal, report last week’s sessions and completions by campaign, source, medium and entry page in site time. Include untagged rows and any incomplete archives.')}
        <p>The entry page is where the visit started. The form can be completed on another page. A return visit can also receive campaign credit under Matomo’s last non-direct attribution model. Select the same site, dates and goal when you compare the result with Matomo. ${cite('matomoGoals', 'Matomo goal reporting')} · ${cite('matomoAttribution', 'How Matomo credits a conversion')}.</p>`),
      section('cost-per-lead', 'Work out cost per lead from campaign spend', `<p>Suppose a paid campaign spent $240 and used two landing pages. The example below shows how to combine the website outcomes before attaching the budget.</p>
        <div class="guide-table"><table><caption>Illustrative results for one campaign and one demo goal</caption><thead><tr><th scope="col">Entry page</th><th scope="col">Sessions</th><th scope="col">Demo completions</th></tr></thead><tbody><tr><td>/demo</td><td>80</td><td>6</td></tr><tr><td>/pricing</td><td>40</td><td>2</td></tr></tbody></table></div>
        <p>The campaign produced eight recorded completions from 120 sessions. Its cost per recorded demo was <strong>$240 ÷ 8 = $30</strong>. You can compare completions per 100 sessions on the two pages (7.5 and 5), but allocating $240 to each page would double the spend. To calculate page-level cost, get spend broken out by destination or by an ad that has a single verified destination.</p>
        <p>Match the Matomo campaign tag to the ad platform’s campaign ID, then compare currencies and reporting time zones. Keep a sitewide total and an unmatched row so a missing tag stays visible. If sales qualifies leads in a CRM, label this figure “cost per demo completion” until the team has reconciled those records. ${cite('adportAcquisition')}.</p>`),
    ],
  },
  'gravity-ai-advertising': {
    title: 'Gravity Ads guide to advertising in AI chat apps',
    marks: ['gravity'],
    sections: [
      section('context', 'Plan a Gravity ad around a buying question', `<p>Gravity uses the conversation in a participating AI app to decide when an ad is relevant. Give the campaign one offer, a destination that delivers it and a description of the buying situation. An accounting software company might want to reach someone comparing invoicing tools for a five-person agency. Someone asking how to correct a tax return has a different need. Those two examples give the buyer a concrete way to review the target context and exclusions.</p>
        <p>Write down the countries you can serve, the devices the destination supports and the outcome you want to measure. Choose <strong>Clicks</strong> to evaluate visits, <strong>Reach</strong> for impressions or <strong>Conversions</strong> for a particular event. Your choice of ChatGPT or Claude to manage the account in Adport is independent of the publisher apps in which Gravity delivers the ad. ${cite('gravityAdvertisers', 'Gravity’s advertiser setup guide')}.</p>`),
      section('tracking', 'Check the conversion path before enabling delivery', `<ol><li>Open <strong>Events Manager</strong> in Gravity and use its pixel test on the page where the customer lands.</li><li>Trace the next step. If a demo is booked in a scheduling service, check how that confirmed booking gets back to Gravity. Gravity documents a Calendly integration and a server-side Conversions API.</li><li>With your team’s test procedure, confirm that one completed action produces the expected event. Compare the event type, timestamp and value with your own record. Then check which events Gravity attributed to an ad.</li></ol>
        <p>In Adport, connect the Gravity advertiser with read access. Use <code>gravity_pixels</code> for its installation status and <code>gravity_conversion_stats</code> for counts by event type. A healthy pixel and an arriving booking are two separate checks. Use the campaign report to find how many of those outcomes Gravity credited to the advertising. ${cite('adportGravity', 'Gravity reporting tools and permissions in Adport')}.</p>`),
      section('weekly-result', 'Read a week of Gravity Ads results', `<p>Take an illustrative campaign that spent $180, received 120 clicks and recorded three attributed bookings. Its CPC is $1.50 and its cost per attributed booking is $60. If the CRM has six bookings from all sources, dividing $180 by six would credit the campaign for every booking. Check the campaign dates and click-through or view-through labels before deciding whether to raise the budget.</p>
        ${prompt('Compare the last two complete weeks in UTC for my selected Gravity advertiser. Show spend in USD, clicks and attributed conversions by campaign. Compute CPC and cost per booking from the totals when booking is the measured event. Flag missing fields and keep lifetime metrics out of the comparison.')}
        <p>For a new test, review the destination, context, budget, objective and initial group in the campaign preview. Check the saved campaign and its delivery status after an approved creation. The first impressions are the point at which the delivery test has actually started. ${cite('adportGravity', 'Campaign creation and reporting definitions')}.</p>`),
    ],
  },
  'meta-ads-reporting': {
    title: 'Meta Ads reporting for creative fatigue and placement performance',
    marks: ['meta'],
    sections: [
      section('delivery', 'Check frequency and response on the same ad', `<p>Pick an ad ID and compare two complete seven-day periods. Keep the audience, objective, attribution window and click definition visible. Frequency is average exposures per person reached. Link CTR is link clicks divided by impressions. If 10,000 impressions generated 120 link clicks in the first week and 75 in the second, link CTR fell from 1.2% to 0.75%. Look up reach and frequency for those same periods before briefing a creative refresh. ${cite('metaInsights')}.</p>`),
      section('placement', 'Find the placement behind the change', `<p>Break delivery down by publisher platform and placement. Suppose Instagram Stories gained most of the impressions while Facebook Feed held its link CTR. Recalculate CTR for each placement and compare the mix before attributing the account decline to the image. Some breakdowns restrict which conversion fields Meta returns. Keep an unavailable purchase count separate from a reported zero. ${cite('metaBreakdowns')}.</p>`),
      section('brief', 'Turn the report into a creative brief', `<p>If the same placement and audience saw the ad more often while both link CTR and purchases fell, give the designer the ad ID, placement, dates and a specific change to test. Preserve the offer and destination while testing a different opening image. If clicks held steady but purchases fell, verify the destination and purchase event first. Record which observation would change the decision at the next review.</p>`),
    ],
  },
  'paid-search-reporting': {
    title: 'Paid search reporting for Google Ads and Microsoft Advertising',
    marks: ['google', 'microsoft'],
    sections: [
      section('weekly', 'Build a comparable paid search report', `<p>Export one row per campaign and platform for a completed week. Keep currency, campaign ID, spend, clicks and the conversion action in the table. A lead form submission on Google and a page visit on Microsoft measure different outcomes. If both campaigns count the same lead and use USD, $300 on ten leads and $100 on two leads combine to $400 ÷ 12, or $33.33 per lead. Preserve separate totals when the definitions differ. ${cite('microsoftCampaignReport')}.</p>`),
      section('queries', 'Review the searches behind a cost increase', `<p>A keyword is what the buyer bid on. A search term is what someone entered. Pick the campaign with the largest spend change, then inspect reported queries alongside match type, cost and leads. A repair shop seeing “free repair manual” can inspect whether those visits ever book a repair before proposing an exclusion. Keep unreported query traffic in the campaign total. ${cite('googleSearchTerms')} · ${cite('microsoftSearchQueries')}.</p>`),
      section('partners', 'Trace Bing and DuckDuckGo delivery', `<p>DuckDuckGo Search ads are bought through Microsoft Advertising. Check the ad group’s distribution, then inspect Microsoft’s publisher usage report where a publisher is disclosed. A campaign-level Microsoft total can include several surfaces. Label the share for which the publisher is unknown before comparing DuckDuckGo performance with Bing or Google. ${cite('duckduckgoAdvertising')} · ${cite('microsoftPublisherReport')}.</p>`),
    ],
  },
  'apple-ads-for-app-developers': {
    title: 'Apple Ads for app developers: cost per install and search terms',
    marks: ['apple'],
    sections: [
      section('first-download', 'Calculate the cost of acquiring a new downloader', `<p>Choose one app, storefront and complete reporting period. Apple distinguishes new downloads from redownloads and can report tap-through and view-through attribution separately. Label the basis of the number you choose. If $240 bought 24 tap-through downloads including six redownloads, the cost per tap-through download is $10. For the 18 new tap-through downloads it is $13.33. Use the denominator that answers the acquisition question. ${cite('appleDashboard')}.</p>`),
      section('terms', 'Choose a search term to test', `<p>In a search results campaign, compare what people searched for with the keyword or Search Match that brought the traffic. Check taps, spend and new downloads for the same storefront. A term that delivered one new download from two taps needs more evidence before it becomes a budget assumption. Record the term and intended match type before adding it to a controlled test. ${cite('appleReporting')} · ${cite('appleSearchMatch')}.</p>`),
      section('campaign', 'Review the first campaign before launch', `<p>Confirm the app, country or region, placement, daily budget and ad group. Check the bid and which searches the targeting can match. Prepare a paused campaign preview in Adport, read the resulting configuration and agree when the first complete reporting period will end. If the storefront or placement changes, start a separate comparison so changes in acquisition cost remain interpretable.</p>`),
    ],
  },
  'connect-ads-to-claude': {
    title: 'Connect ad accounts to Claude and Claude Code with MCP',
    marks: ['claude', 'mcp'],
    sections: [
      section('authorize', 'Connect the Adport project to Claude', `<p>In the Adport project for your brand, connect the advertising platform and enable the account your assistant should read. For Claude web or desktop, add the hosted Adport URL as a custom connector, finish sign-in and enable the connector in the conversation. For Claude Code, add the hosted server in a terminal:</p>${code(agentSetups.find(a => a.id === 'claude-code').command(mcpBaseUrl))}<p>Open Claude Code, run <code>/mcp</code> and complete the Adport authorization. A local stdio setup runs where your CLI credentials are stored. ${cite('claude')} · ${cite('claudeConnectors')}.</p>`),
      section('first-report', 'Verify the account with one known campaign', `<p>Ask Claude to list enabled accounts and select the advertiser ID printed in the provider dashboard. Then ask for spend on one familiar campaign during the last completed week. Match the dates, currency and time zone to the provider’s own report. If your agency runs the same campaign name for two clients, compare IDs before investigating any difference.</p>`),
      section('troubleshoot', 'Find a missing account or tool', `<p>If Claude connects but lists no account, check the project selected during sign-in and the accounts enabled for assistant access. If it can report but cannot perform a requested action, inspect the connection’s tool permissions. Start with a read to confirm the repair. For a later budget change, review the current amount, proposed amount and scope in the preview before approving it.</p>`),
    ],
  },
  'connect-ads-to-chatgpt': {
    title: 'Connect ad accounts to ChatGPT for campaign reporting',
    marks: ['chatgpt', 'mcp'],
    sections: [
      section('install', 'Install Adport and select the advertiser', `<p>Open the <a href="${CHATGPT_PLUGIN_URL}">Adport listing in ChatGPT</a> and complete the Adport sign-in. Choose the project with the advertiser you intend to review. In Adport, check that the provider is connected and that the account has assistant access enabled. Start a chat, select Adport and ask it to list the project’s available ad accounts.</p><p>If two projects both have an account called “US acquisition”, use the provider and account ID in your report request. A successful sign-in alone cannot establish which advertiser you are reading.</p>`),
      section('report', 'Compare two complete periods in ChatGPT', `<p>For a first report, choose one campaign and the last two complete weeks in account time. Ask for spend, clicks and one named conversion on separate rows for each week. For example, a change from $200 on ten purchases to $300 on twelve increased the purchase count but also raised cost per purchase from $20 to $25. Decide which outcome matters to the buyer before recommending a budget change.</p>`),
      section('scope', 'Check what the connection can do', `<p>Call <code>capabilities_list</code> for the selected provider when a tool is missing. For recent multi-platform campaign lists, hosted Standard connections use <code>campaigns_list</code> with a provider and account ID. If you also need to change delivery, check the plan and permissions and review the proposed change with the campaign owner. ${cite('adportCatalog', 'Adport’s hosted tool access and campaign operations')}.</p>`),
    ],
  },
  'ai-ad-management': {
    title: 'AI ad management with MCP: from a report to an approved change',
    marks: ['mcp'],
    sections: [
      section('scope', 'Give the assistant a question with a verifiable answer', `<p>Pick one client, advertiser ID, currency and complete date range. “Which campaign contributed most to last week’s increase in spend?” has a checkable answer. Ask for each campaign’s absolute change and the account total. If spend rose by $400 and one campaign rose by $320, that campaign accounted for 80% of the net increase. Also inspect campaigns that fell in spend.</p>`),
      section('evidence', 'Read the account before choosing an action', `<p>Use <code>accounts_list</code> to verify scope and <code>report</code> for dated performance. Then inspect the campaign’s actual configuration. High spend, a rising daily budget and a longer reporting period each require different explanations. The hosted Standard profile exposes common campaign operations across supported providers. Use <code>capabilities_list</code> when the requested tool is missing. ${cite('adportCatalog')}.</p>`),
      section('approval', 'Verify exactly what an approved change will do', `<p>Suppose the owner wants to pause a single campaign. Read back its current status and advertiser, request a preview and compare the campaign ID against the original report. Approve only that reviewed operation. After application, read back the saved status and keep the receipt beside the observed outcome. Delivery metrics from before the pause can still appear in later reports.</p>`),
    ],
  },
  'google-ads-optimization': {
    title: 'Google Ads optimization: conversion checks, search terms and budget pacing',
    marks: ['google'],
    sections: [
      section('measurement', 'Audit conversion counting before changing bids', `<p>If a lead campaign’s CPA doubles, check the conversion action, tracking status and recent conversion delay. Compare completed periods and confirm whether the account counts form submissions, qualified leads or both. A tagging change on the thank-you page can make the campaign appear worse even when the sales team sees steady demand. ${cite('lag')}.</p>`),
      section('negatives', 'Choose a negative keyword from actual search intent', `<p>A shop selling new office chairs might want to exclude a search for “office chair repair manual”. Inspect the exact query, conversions and the profitable terms sharing those words. Excluding “office chair” broadly could remove the shop’s core business. Review the proposed negative, its match type and the campaign or shared list where it will apply. ${cite('terms')} · ${cite('negatives')}.</p>`),
      section('pace', 'Separate the monthly plan from the daily budget setting', `<p>In a 30-day month, spending $900 in the first ten complete days projects to $2,700 at the observed pace. A $3,000 plan leaves $2,100 for 20 days, or $105 per day. Those are planning figures. Check weekday patterns, campaign eligibility and Google’s spending limits before changing a budget. Use the pacing calculator below to repeat the calculation with your own dates. ${cite('limits')}.</p>`),
    ],
  },
  'marketing-analytics': {
    title: 'Marketing analytics with MCP for Matomo, GA4 and Search Console',
    marks: ['matomo', 'ga4', 'gsc'],
    sections: [
      section('sources', 'Choose the report that measures the stage you care about', `<p>Use Search Console to learn which Google searches showed a landing page and earned clicks. Use the site’s GA4 property or Matomo site to see which acquisition sources sent sessions and what visitors did. Use an advertising account for spend. Start with one question, such as “Did more organic visitors reach our demo page?” Compare Google organic search clicks with organic sessions landing on that page, and keep the two measures labeled. ${cite('searchConsolePerformance')} · ${cite('ga4Schema')}.</p>`),
      section('goal', 'Pick the same business outcome across reports', `<p>Use <code>analytics_goals</code> to look up a specific GA4 key event or Matomo goal. Run <code>analytics_acquisition_report</code> for that property, goal and period. A page view, a submitted form and a sales-qualified lead are different steps even if each tool labels one of them “conversion”. Document which event you counted and which site owns its ID. ${cite('adportAcquisition')}.</p>`),
      section('reconcile', 'Reconcile the totals before explaining a gap', `<p>Suppose a campaign has ten recorded site completions and eight ad-attributed conversions. Check the tagged campaign, dates, time zones and attribution rules before calling two events missing. Sum site rows to campaign level before matching spend. A tag used by several campaigns needs an explicit mapping. Keep the unresolved traffic visible so the buyer can see how much of the result is explained.</p>`),
    ],
  },
  'agency-operations': {
    title: 'Agency ad management: client access, approvals and reporting',
    marks: ['google', 'meta'],
    sections: [
      section('access', 'Separate client projects and verify access', `<p>Use one project per client or brand. During onboarding, record the advertiser’s platform, ID, currency and time zone alongside the person who owns budget decisions. If a Google Ads manager can see several advertisers, select and enable only the intended child account for the client’s project. Manager account access levels affect which actions are available. ${cite('access')}.</p>`),
      section('handoff', 'Agree who can read a report and who can change spend', `<p>A client finance contact may need the weekly spend report while a buyer prepares changes. Give each person the access their role requires. A media-plan approval such as “up to $5,000 this month” still leaves the operator to specify the advertiser, campaign, budget type and proposed change. Check those details in the preview before approving it and keep the actual receipt for handoff.</p>`),
      section('report', 'Calculate the figures the client can verify', `<p>For two campaigns in USD with the same purchase definition, $500 on ten purchases and $100 on two purchases combine to $600 on twelve purchases, or $50 CPA. Add a separate revenue column when the client wants ROAS. Distinguish platform-attributed purchases from fulfilled orders in the client’s commerce system, and keep different currencies on separate rows until both parties agree on a conversion method. ${cite('values')}.</p>`),
    ],
  },
};

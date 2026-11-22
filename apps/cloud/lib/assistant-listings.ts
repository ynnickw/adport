import { ADPORT_CLOUD_URL, CHATGPT_PLUGIN_URL } from '@/lib/agent-setups.mjs';

export type AssistantListings = Partial<Record<'chatgpt' | 'claude', string>>;

export function approvedAssistantListings(config: { chatgpt?: string; claude?: string; baseUrl?: string }): AssistantListings {
  const hostedChatgpt = config.baseUrl?.replace(/\/+$/, '') === ADPORT_CLOUD_URL ? CHATGPT_PLUGIN_URL : undefined;
  const urls = { chatgpt: config.chatgpt || hostedChatgpt, claude: config.claude };
  const listings: AssistantListings = {};
  for (const id of ['chatgpt', 'claude'] as const) {
    const href = urls[id];
    if (!href) continue;
    try {
      const url = new URL(href);
      if (url.protocol === 'https:' && url.hostname === (id === 'chatgpt' ? 'chatgpt.com' : 'claude.ai')
        && !url.username && !url.password && !url.port && url.pathname !== '/') listings[id] = url.href;
    } catch { /* Invalid configuration must not hide working manual setup. */ }
  }
  return listings;
}

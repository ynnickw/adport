export type AssistantListings = Partial<Record<'chatgpt' | 'claude', string>>;

/** Unconfigured listings use the existing manual setup, without promising approval. */
export function approvedAssistantListings(config: { chatgpt?: string; claude?: string }): AssistantListings {
  const listings: AssistantListings = {};
  for (const id of ['chatgpt', 'claude'] as const) {
    if (!config[id]) continue;
    try {
      const url = new URL(config[id]);
      if (url.protocol === 'https:' && url.hostname === (id === 'chatgpt' ? 'chatgpt.com' : 'claude.ai')
        && !url.username && !url.password && !url.port && url.pathname !== '/') listings[id] = url.href;
    } catch { /* Invalid configuration must not hide working manual setup. */ }
  }
  return listings;
}

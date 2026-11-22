import 'server-only';
import { env } from '@/lib/env';
import { approvedAssistantListings } from '@/lib/assistant-listings';

export function getAssistantListings() {
  const config = env();
  return approvedAssistantListings({
    baseUrl: config.ADPORT_CLOUD_BASE_URL,
    chatgpt: config.ADPORT_APPROVED_CHATGPT_LISTING_URL,
    claude: config.ADPORT_APPROVED_CLAUDE_LISTING_URL,
  });
}

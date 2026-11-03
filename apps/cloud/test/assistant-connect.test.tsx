import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AssistantConnect } from '@/components/assistant-connect';
import { approvedAssistantListings } from '@/lib/assistant-listings';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe('assistant connection navigation', () => {
  it('exposes the selected assistant as the keyboard entry point and names its panel', () => {
    const html = renderToStaticMarkup(<AssistantConnect baseUrl="https://app.adport.test" projectName="Product marketing" initialAgent="codex" />);
    const selected = html.match(/id="([^"]+-tab-codex)"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="([^"]+)"[^>]*tabindex="0"/);
    expect(selected).not.toBeNull();
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain(`id="${selected![2]}" role="tabpanel" aria-labelledby="${selected![1]}"`);
    expect(html).toContain('codex mcp add adport --url https://app.adport.test/mcp');
    expect(html).not.toContain('<select');
  });

  it.each(['chatgpt', 'claude'])('keeps %s manual setup available before its official connector is live', initialAgent => {
    const html = renderToStaticMarkup(<AssistantConnect baseUrl="https://app.adport.test" projectName="Product marketing" initialAgent={initialAgent} listings={approvedAssistantListings({})} />);
    expect(html).toContain('Copy URL');
    expect(html).not.toContain('from the official');
    expect(html).not.toContain('Set up manually');
  });

  it.each([['chatgpt', 'ChatGPT', 'https://chatgpt.com/plugins/approved-adport'], ['claude', 'Claude', 'https://claude.ai/directory/approved-adport']] as const)('enables the official %s connector button once its approved URL is configured', (initialAgent, name, url) => {
    const listings = approvedAssistantListings({ [initialAgent]: url });
    const html = renderToStaticMarkup(<AssistantConnect baseUrl="https://app.adport.test" projectName="Product marketing" initialAgent={initialAgent} listings={listings} />);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`aria-label="Add Adport from the official ${name} connector"`);
    expect(html).toContain(`Add to ${name}`);
    expect(html).toContain('Connection guide');
    expect(html).not.toContain('Copy URL');
    expect(html).not.toContain('Set up manually');
  });
});

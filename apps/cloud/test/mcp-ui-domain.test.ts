import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mcpUiDomain } from '@/lib/mcp-ui-domain';

describe('MCP Apps host domain', () => {
  it('hashes the complete canonical connector URL for Claude', () => {
    const url = 'https://app.adport.dev/mcp';
    expect(mcpUiDomain(['https://claude.ai/api/mcp/auth_callback'], url))
      .toBe(`${createHash('sha256').update(url).digest('hex').slice(0, 32)}.claudemcpcontent.com`);
    expect(mcpUiDomain(['https://claude.ai/api/mcp/auth_callback'], `${url}/`))
      .not.toBe(mcpUiDomain(['https://claude.ai/api/mcp/auth_callback'], url));
  });

  it.each([
    [], ['https://chatgpt.com/connector/oauth/callback'], ['not a URL'],
    ['https://claude.ai.evil.test/api/mcp/auth_callback'],
    ['http://claude.ai/api/mcp/auth_callback'], ['https://claude.ai/unrelated'],
    ['https://user:password@claude.ai/api/mcp/auth_callback'],
  ].map(uris => ({ uris })))('keeps default metadata for non-Claude callbacks: $uris', ({ uris }) => {
    expect(mcpUiDomain(uris, 'https://app.adport.dev/mcp')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { mcpUiDomain } from '@/lib/mcp-ui-domain';

describe('MCP Apps host domain', () => {
  it('lets Claude choose its default sandbox without changing the connector grant', () => {
    expect(mcpUiDomain(['https://claude.ai/api/mcp/auth_callback'])).toBeNull();
  });

  it.each([
    [], ['https://chatgpt.com/connector/oauth/callback'], ['not a URL'],
    ['https://claude.ai.evil.test/api/mcp/auth_callback'],
    ['http://claude.ai/api/mcp/auth_callback'], ['https://claude.ai/unrelated'],
    ['https://user:password@claude.ai/api/mcp/auth_callback'],
  ].map(uris => ({ uris })))('keeps default metadata for non-Claude callbacks: $uris', ({ uris }) => {
    expect(mcpUiDomain(uris)).toBeUndefined();
  });
});

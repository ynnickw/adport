import { createHash } from 'node:crypto';

/** Presentation routing only, never an authorization or trust decision. */
export function mcpUiDomain(redirectUris: readonly string[], resourceUrl: string): string | undefined {
  const isClaude = redirectUris.some(value => {
    try {
      const url = new URL(value);
      return url.origin === 'https://claude.ai'
        && url.pathname === '/api/mcp/auth_callback'
        && !url.username && !url.password;
    } catch {
      return false;
    }
  });
  // Host-specific format documented by the MCP Apps SDK's CSP/CORS pattern.
  return isClaude
    ? `${createHash('sha256').update(resourceUrl).digest('hex').slice(0, 32)}.claudemcpcontent.com`
    : undefined;
}

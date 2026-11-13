/** Presentation routing only, never an authorization or trust decision. */
export function mcpUiDomain(redirectUris: readonly string[]): null | undefined {
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
  // Stable ui.domain is optional. This UI has no OAuth callback or origin-based
  // API allowlist, so Claude can use its normal isolated conversation sandbox.
  return isClaude ? null : undefined;
}

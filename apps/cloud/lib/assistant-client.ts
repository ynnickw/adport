/** Client metadata describes the UI target; it never grants permissions. */
export function matchesAssistant(agent: string | undefined, client: { clientName: string; clientUri: string | null; kind: string }): boolean {
  if (!agent || agent === 'mcp') return true;
  if (client.kind === 'key') return false; // A shared key cannot identify its host.
  const name = client.clientName.toLowerCase();
  let host = '';
  try { host = new URL(client.clientUri ?? '').hostname; } catch { /* Client URI is optional. */ }
  if (/claude[ -]?code/.test(name) || host === 'code.claude.com') return agent === 'claude-code';
  if (/codex/.test(name)) return agent === 'codex';
  if (/cursor/.test(name) || host === 'cursor.com') return agent === 'cursor';
  if (/claude|anthropic/.test(name) || host === 'claude.ai') return agent === 'claude';
  if (/chatgpt|openai/.test(name) || host === 'chatgpt.com') return agent === 'chatgpt';
  return false;
}

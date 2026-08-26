'use client';

import { useState } from 'react';

type Setup = {
  id: string;
  name: string;
  mark: string;
  label: string;
  instructions: string;
  command: (baseUrl: string) => string;
};

const SETUPS: Setup[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    mark: 'AI',
    label: 'Settings → Apps → Create',
    instructions: 'Enable developer mode, create a custom app, paste this endpoint, select OAuth, then scan the tools.',
    command: (baseUrl) => `${baseUrl}/mcp`,
  },
  {
    id: 'codex',
    name: 'Codex',
    mark: 'CX',
    label: 'CLI · recommended',
    instructions: 'Run both commands. The second opens Adport in your browser to approve this workspace.',
    command: (baseUrl) => `codex mcp add adport --url ${baseUrl}/mcp\ncodex mcp login adport`,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    mark: 'CL',
    label: 'CLI · user scope',
    instructions: 'Add Adport once for your user, then run /mcp in Claude Code if authentication does not open automatically.',
    command: (baseUrl) => `claude mcp add --transport http --scope user adport ${baseUrl}/mcp`,
  },
  {
    id: 'claude',
    name: 'Claude',
    mark: 'CA',
    label: 'Web & Desktop',
    instructions: 'Open Customize → Connectors → Add custom connector, name it Adport, and paste this endpoint.',
    command: (baseUrl) => `${baseUrl}/mcp`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    mark: 'CU',
    label: '~/.cursor/mcp.json',
    instructions: 'Add this global configuration, restart Cursor, and approve the browser sign-in when prompted.',
    command: (baseUrl) => JSON.stringify({ mcpServers: { adport: { url: `${baseUrl}/mcp` } } }, null, 2),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    mark: 'VS',
    label: 'MCP: Open User Configuration',
    instructions: 'Open the Command Palette, choose “MCP: Open User Configuration”, paste this server, then start it.',
    command: (baseUrl) => JSON.stringify({ servers: { adport: { type: 'http', url: `${baseUrl}/mcp` } } }, null, 2),
  },
];

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button className="setup-copy" type="button" onClick={copy} aria-label={`Copy ${label} setup`}>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function AgentSetupGuide({ baseUrl }: { baseUrl: string }) {
  return (
    <section className="card agent-setup-card">
      <div className="card-head">
        <div>
          <h2>Connect your agent</h2>
          <p className="card-kicker">Choose a client and copy its ready-to-run setup.</p>
        </div>
        <span className="status">OAuth recommended</span>
      </div>
      <div className="card-body agent-setup-body">
        <ol className="setup-steps" aria-label="Adport setup steps">
          <li><span>1</span><div><strong>Connect ad providers</strong><small>Authorize the platforms the agent may access.</small></div></li>
          <li><span>2</span><div><strong>Add Adport MCP</strong><small>Use one setup below and finish browser authorization.</small></div></li>
          <li><span>3</span><div><strong>Start with a read</strong><small>Ask the agent to list accounts before making changes.</small></div></li>
        </ol>

        <div className="agent-setup-grid">
          {SETUPS.map((setup) => {
            const command = setup.command(baseUrl);
            return (
              <article className="agent-setup" key={setup.id}>
                <header>
                  <span className={`agent-mark ${setup.id}`} aria-hidden="true">{setup.mark}</span>
                  <div><h3>{setup.name}</h3><p>{setup.label}</p></div>
                </header>
                <p className="agent-instruction">{setup.instructions}</p>
                <div className="setup-code-wrap">
                  <pre className="setup-code"><code>{command}</code></pre>
                  <CopyButton value={command} label={setup.name} />
                </div>
              </article>
            );
          })}
        </div>

        <aside className="setup-practice">
          <div><strong>Safe first prompt</strong><p>“List my accessible ad accounts and summarize the last 7 days. Do not make any changes.”</p></div>
          <ul>
            <li>Prefer OAuth MCP; never paste platform secrets or access tokens into a chat.</li>
            <li>Use project-level configs for shared repositories and user-level configs only on trusted devices.</li>
            <li>Review the exact preview before applying a write. New campaigns remain paused by policy.</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

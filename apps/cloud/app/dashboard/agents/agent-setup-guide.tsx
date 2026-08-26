'use client';

import { useState } from 'react';
import { SiAnthropic, SiCursor } from 'react-icons/si';
import { VscVscode } from 'react-icons/vsc';

type Setup = {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'cursor' | 'vscode';
  label: string;
  instructions: string;
  nextStep: string;
  command: (baseUrl: string) => string;
};

const SETUPS: Setup[] = [
  {
    id: 'chatgpt', name: 'ChatGPT', provider: 'openai', label: 'Custom app',
    instructions: 'Enable developer mode, then open Settings → Apps → Create. Choose OAuth and use the endpoint below.',
    nextStep: 'Scan the tools, finish Adport authorization, and enable the new app in your chat.',
    command: (baseUrl) => `${baseUrl}/mcp`,
  },
  {
    id: 'codex', name: 'Codex', provider: 'openai', label: 'CLI',
    instructions: 'Run these commands once. Codex stores the MCP configuration and opens Adport authorization in your browser.',
    nextStep: 'Confirm the server with “codex mcp list”, then ask Codex to list your ad accounts.',
    command: (baseUrl) => `codex mcp add adport --url ${baseUrl}/mcp\ncodex mcp login adport`,
  },
  {
    id: 'claude-code', name: 'Claude Code', provider: 'anthropic', label: 'CLI',
    instructions: 'Add Adport at user scope so it is available across your local projects.',
    nextStep: 'Run /mcp inside Claude Code if the browser authorization does not open automatically.',
    command: (baseUrl) => `claude mcp add --transport http --scope user adport ${baseUrl}/mcp`,
  },
  {
    id: 'claude', name: 'Claude', provider: 'anthropic', label: 'Web & Desktop',
    instructions: 'Open Customize → Connectors → Add custom connector. Name it Adport and use the endpoint below.',
    nextStep: 'Select Connect, approve the workspace, then enable Adport from the + menu in a conversation.',
    command: (baseUrl) => `${baseUrl}/mcp`,
  },
  {
    id: 'cursor', name: 'Cursor', provider: 'cursor', label: 'Global MCP',
    instructions: 'Add this server to ~/.cursor/mcp.json, then restart Cursor.',
    nextStep: 'Approve the browser sign-in when prompted. Cursor will keep the OAuth session refreshed.',
    command: (baseUrl) => JSON.stringify({ mcpServers: { adport: { url: `${baseUrl}/mcp` } } }, null, 2),
  },
  {
    id: 'vscode', name: 'VS Code', provider: 'vscode', label: 'User MCP',
    instructions: 'Open the Command Palette and choose “MCP: Open User Configuration”, then add this server.',
    nextStep: 'Start the Adport server from VS Code and complete the browser authorization.',
    command: (baseUrl) => JSON.stringify({ servers: { adport: { type: 'http', url: `${baseUrl}/mcp` } } }, null, 2),
  },
];

function OpenAiLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function AgentLogo({ provider }: { provider: Setup['provider'] }) {
  if (provider === 'openai') return <OpenAiLogo />;
  if (provider === 'anthropic') return <SiAnthropic aria-hidden="true" />;
  if (provider === 'cursor') return <SiCursor aria-hidden="true" />;
  return <VscVscode aria-hidden="true" />;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button className="setup-copy" type="button" onClick={copy} aria-label={`Copy ${label} setup`}>
      {copied ? 'Copied' : 'Copy setup'}
    </button>
  );
}

export function AgentSetupGuide({ baseUrl }: { baseUrl: string }) {
  const [selectedId, setSelectedId] = useState(SETUPS[0]!.id);
  const selected = SETUPS.find((setup) => setup.id === selectedId) ?? SETUPS[0]!;
  const command = selected.command(baseUrl);

  return (
    <section className="card agent-setup-card">
      <div className="card-head">
        <div>
          <h2>Connect your agent</h2>
          <p className="card-kicker">Choose a client. Only its recommended setup is shown.</p>
        </div>
        <span className="status">OAuth recommended</span>
      </div>

      <div className="agent-tabs" aria-label="Choose an agent">
        {SETUPS.map((setup) => (
          <button className="agent-tab" data-active={setup.id === selected.id} key={setup.id} type="button" onClick={() => setSelectedId(setup.id)} aria-pressed={setup.id === selected.id}>
            <span className={`agent-logo ${setup.provider}`}><AgentLogo provider={setup.provider} /></span>
            <span>{setup.name}</span>
          </button>
        ))}
      </div>

      <div className="card-body agent-setup-body">
        <article className="agent-panel" aria-live="polite">
          <div className="agent-panel-copy">
            <div className="agent-panel-title">
              <span className={`agent-logo large ${selected.provider}`}><AgentLogo provider={selected.provider} /></span>
              <div><h3>{selected.name}</h3><p>{selected.label}</p></div>
            </div>
            <p className="agent-instruction">{selected.instructions}</p>
            <p className="agent-next"><strong>Then:</strong> {selected.nextStep}</p>
          </div>
          <div className="setup-code-wrap">
            <pre className="setup-code"><code>{command}</code></pre>
            <CopyButton value={command} label={selected.name} />
          </div>
        </article>

        <aside className="setup-practice">
          <div><strong>Safe first prompt</strong><p>“List my accessible ad accounts and summarize the last 7 days. Do not make any changes.”</p></div>
          <ul>
            <li>Prefer OAuth MCP; never paste platform secrets into a chat.</li>
            <li>Review the exact preview before applying any write.</li>
            <li>New campaigns remain paused by policy.</li>
          </ul>
        </aside>
      </div>
    </section>
  );
}

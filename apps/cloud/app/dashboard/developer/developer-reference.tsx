'use client';

import { useState } from 'react';
import { PiArrowUpRight } from 'react-icons/pi';
import { CopyButton } from '@/components/copy-button';
import { InfoTooltip } from '@/components/info-tooltip';
import { FilterButtons } from '@/components/list-controls';
import { adportToolSearchConfig } from '@/lib/mcp-tool-search-config';

const endpoints = [
  { label: 'MCP server', path: '/mcp' },
  { label: 'List ad accounts', method: 'GET', path: '/api/v1/accounts' },
  { label: 'Run a tool', method: 'POST', path: '/api/v1/tools/<tool>' },
];

export function DeveloperReference({ baseUrl }: { baseUrl: string }) {
  const examples = adportToolSearchConfig(baseUrl);
  const [selectedName, setSelectedName] = useState(examples[0]!.name);
  const example = examples.find(item => item.name === selectedName) ?? examples[0]!;

  return <>
    <section className="settings-section" aria-labelledby="developer-endpoints">
      <div className="settings-section-head"><h2 id="developer-endpoints">Endpoints</h2></div>
      <ul className="settings-list">
        {endpoints.map(({ label, method, path }) => {
          const url = baseUrl + path;
          return <li key={path} className="settings-row developer-endpoint">
            <div className="settings-row-copy">
              <strong>{label}</strong>
              <p className="settings-note">{method ? <code className="developer-method">{method}</code> : null}<code>{url}</code></p>
            </div>
            <CopyButton value={url} label={`Copy ${label} URL`} caption="Copy URL" />
          </li>;
        })}
      </ul>
    </section>
    <section className="settings-section developer-tool-search" id="tool-search" aria-labelledby="developer-tool-search">
      <div className="settings-section-head">
        <h2 id="developer-tool-search">Tool search <InfoTooltip label="About tool search">Use a Full key to load specialist tools on demand. The key’s selected platforms, scopes, and approvals still apply.</InfoTooltip></h2>
        <a href={example.docsUrl} className="link-button settings-link" target="_blank" rel="noreferrer">API guide <PiArrowUpRight aria-hidden="true" /></a>
      </div>
      <div className="developer-example-toolbar">
        <FilterButtons label="Example API" options={examples.map(({ name }) => ({ value: name, label: name }))} value={selectedName} onChange={setSelectedName} />
        <CopyButton key={example.name} value={example.config} label={`Copy ${example.name} tool search config`} caption="Copy JSON" />
      </div>
      <p className="settings-note developer-example-note">Replace <code>YOUR_ADPORT_API_KEY</code> in your server-side request.</p>
      {example.header ? <p className="settings-note developer-header-note">Request header <code>{example.header}</code></p> : null}
      <pre className="developer-example" aria-label={`${example.name} request example`}><code>{example.config}</code></pre>
    </section>
  </>;
}

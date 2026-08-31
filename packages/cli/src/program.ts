import { Command } from 'commander';
import packageJson from '../package.json';
import {
  AdportError,
  AuditLog,
  CredentialStore,
  type AdportRuntime,
  type AnyToolDefinition,
} from '@adport/core';

export interface ProgramIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: ProgramIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function table(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(empty)';
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join('  ');
  return [line(keys), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(keys.map((k) => String(r[k] ?? ''))))].join('\n');
}

async function runtime(includeMock?: boolean): Promise<AdportRuntime> {
  const { assembleRuntime } = await import('@adport/mcp');
  return assembleRuntime({ includeMock });
}

export function buildProgram(io: ProgramIO = defaultIO): Command {
  const program = new Command('adport');
  program
    .description('The open control plane for paid media (MCP + CLI)')
    .option('--demo', 'Use synthetic mock accounts and tools (never real provider data)')
    .version(packageJson.version)
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });
  const commandRuntime = () => runtime(program.opts<{ demo?: boolean }>().demo === true ? true : undefined);

  const tools = program.command('tools').description('Inspect and invoke the shared tool registry');

  tools
    .command('list')
    .description('List available tools')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const { registry } = await commandRuntime();
      const defs = registry.list();
      if (opts.json) {
        io.out(
          json(
            defs.map((t: AnyToolDefinition) => ({
              name: t.name,
              namespace: t.namespace,
              readOnly: t.annotations.readOnly ?? false,
              destructive: t.annotations.destructive ?? false,
            })),
          ),
        );
        return;
      }
      io.out(
        table(
          defs.map((t) => ({
            name: t.name,
            namespace: t.namespace,
            mode: t.annotations.readOnly ? 'read' : t.annotations.destructive ? 'DESTRUCTIVE' : 'write',
          })),
        ),
      );
    });

  tools
    .command('run <name>')
    .description('Invoke a tool with JSON input (the same tools the MCP server exposes)')
    .option('--input <json>', 'JSON object with the tool arguments', '{}')
    .action(async (name: string, opts: { input: string }) => {
      const rt = await commandRuntime();
      const result = await rt.registry.call(name, JSON.parse(opts.input), rt.ctx);
      io.out(json(result));
    });

  program
    .command('accounts')
    .description('List connected ad accounts across providers')
    .option('--provider <id>', 'Limit to one provider')
    .option('--json', 'JSON output')
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const rt = await commandRuntime();
      const result = (await rt.registry.call('accounts_list', { provider: opts.provider }, rt.ctx)) as {
        accounts: Array<Record<string, unknown>>;
      };
      io.out(opts.json ? json(result.accounts) : table(result.accounts));
    });

  program
    .command('report')
    .description('Normalized cross-platform performance report')
    .option('--provider <id>', 'Limit to one provider')
    .option('--level <level>', 'account | campaign | ad_group | ad', 'campaign')
    .option('--metrics <list>', 'Comma-separated metrics', 'spend,impressions,clicks,conversions')
    .option('--range <range>', 'Preset (last_7_days, ...) or START..END', 'last_7_days')
    .option('--limit <n>', 'Max rows', '100')
    .option('--json', 'JSON output')
    .action(async (opts: { provider?: string; level: string; metrics: string; range: string; limit: string; json?: boolean }) => {
      const rt = await commandRuntime();
      const dateRange = opts.range.includes('..')
        ? { start: opts.range.split('..')[0]!, end: opts.range.split('..')[1]! }
        : opts.range;
      const result = (await rt.registry.call(
        'report',
        {
          provider: opts.provider,
          level: opts.level,
          metrics: opts.metrics.split(',').map((m) => m.trim()),
          date_range: dateRange,
          limit: Number(opts.limit),
        },
        rt.ctx,
      )) as { rows: Array<{ provider: string; accountId: string; entity: { name: string; status?: string }; metrics: Record<string, number> }>; truncated: boolean };
      if (opts.json) {
        io.out(json(result));
        return;
      }
      io.out(
        table(
          result.rows.map((r) => ({
            provider: r.provider,
            account: r.accountId,
            entity: r.entity.name,
            status: r.entity.status ?? '',
            ...r.metrics,
          })),
        ),
      );
      if (result.truncated) io.err('(truncated — raise --limit for more rows)');
    });

  program
    .command('policy')
    .description('Show the active write policy and where it was loaded from')
    .action(async () => {
      const rt = await commandRuntime();
      io.out(json({ source: rt.policySource, policy: rt.ctx.engine.policy }));
    });

  const audit = program.command('audit').description('Inspect or extend the write-audit trail');

  audit
    .command('show', { isDefault: true })
    .description('Show recent write-audit entries')
    .option('--limit <n>', 'Max entries', '20')
    .action(async (opts: { limit: string }) => {
      const entries = await new AuditLog().read(Number(opts.limit));
      if (entries.length === 0) {
        io.out('No audit entries yet.');
        return;
      }
      io.out(entries.map((e) => JSON.stringify(e)).join('\n'));
    });

  audit
    .command('export')
    .description('Export write-audit entries to stdout for archival or compliance ingestion')
    .option('--limit <n>', 'Max entries', '10000')
    .option('--format <format>', 'jsonl | json', 'jsonl')
    .action(async (opts: { limit: string; format: string }) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new AdportError('INVALID_INPUT', '--limit must be a positive integer');
      }
      if (opts.format !== 'jsonl' && opts.format !== 'json') {
        throw new AdportError('INVALID_INPUT', '--format must be jsonl or json');
      }
      const entries = await new AuditLog().read(limit);
      io.out(opts.format === 'json' ? json(entries) : entries.map((e) => JSON.stringify(e)).join('\n'));
    });

  audit
    .command('run')
    .description('Run the audit rule packs over connected accounts and persist findings')
    .option('--provider <id>', 'Limit to one provider')
    .option('--range <range>', 'Preset or START..END', 'last_30_days')
    .action(async (opts: { provider?: string; range: string }) => {
      const rt = await commandRuntime();
      const dateRange = opts.range.includes('..')
        ? { start: opts.range.split('..')[0]!, end: opts.range.split('..')[1]! }
        : opts.range;
      const result = (await rt.registry.call(
        'audit_run',
        { provider: opts.provider, date_range: dateRange },
        rt.ctx,
      )) as { findings: Array<{ id: string; severity: string; title: string }>; counts: Record<string, number>; evaluatedAccounts: number };
      io.out(`Evaluated ${result.evaluatedAccounts} account(s): ${result.counts.critical} critical, ${result.counts.warn} warn, ${result.counts.info} info`);
      for (const finding of result.findings) {
        io.out(`  [${finding.severity.toUpperCase()}] ${finding.id}\n    ${finding.title}`);
      }
      if (result.findings.length > 0) io.out('Next: adport recommendations  ·  adport recommendations apply <id>');
    });

  audit
    .command('note <text>')
    .description('Record an external/manual change in the audit trail (e.g. a change made in the platform UI)')
    .option('--provider <id>', 'Provider the change concerns', 'external')
    .option('--account <id>', 'Account id the change concerns', '-')
    .action(async (text: string, opts: { provider: string; account: string }) => {
      await new AuditLog().append({
        event: 'note',
        provider: opts.provider,
        tool: 'audit_note',
        accountId: opts.account,
        summary: text,
      });
      io.out('Noted.');
    });

  program
    .command('connect <provider>')
    .description('Connect an ad account (guided wizard)')
    .option('--no-browser', 'Print auth URLs instead of opening a browser')
    .action(async (provider: string, opts: { browser: boolean }) => {
      if (provider === 'google') {
        const { connectGoogle } = await import('./connect/google.js');
        await connectGoogle({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'meta') {
        const { connectMeta } = await import('./connect/meta.js');
        await connectMeta({ io });
        return;
      }
      if (provider === 'tiktok') {
        const { connectTikTok } = await import('./connect/tiktok.js');
        await connectTikTok({ io });
        return;
      }
      if (provider === 'apple') {
        const { connectApple } = await import('./connect/apple.js');
        await connectApple({ io });
        return;
      }
      if (provider === 'microsoft') {
        const { connectMicrosoft } = await import('./connect/microsoft.js');
        await connectMicrosoft({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'reddit') {
        const { connectReddit } = await import('./connect/reddit.js');
        await connectReddit({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'snapchat') {
        const { connectSnapchat } = await import('./connect/snapchat.js');
        await connectSnapchat({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'spotify') {
        const { connectSpotify } = await import('./connect/spotify.js');
        await connectSpotify({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'pinterest') {
        const { connectPinterest } = await import('./connect/pinterest.js');
        await connectPinterest({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'linkedin') {
        const { connectLinkedIn } = await import('./connect/linkedin.js');
        await connectLinkedIn({ openBrowser: opts.browser, io });
        return;
      }
      if (provider === 'mock') {
        io.out('The mock provider is explicit demo mode, not a connection. Try: adport --demo accounts');
        return;
      }
      if (provider === 'x') {
        const { connectX } = await import('./connect/x.js');
        await connectX({ openBrowser: opts.browser, io });
        return;
      }
      io.err(`Provider "${provider}" is not supported. Available: google, meta, tiktok, apple, microsoft, reddit, snapchat, spotify, pinterest, linkedin, x, mock.`);
      process.exitCode = 1;
    });

  program
    .command('disconnect <provider>')
    .description('Remove a provider connection from this machine')
    .action(async (provider: string) => {
      if (!['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'].includes(provider)) {
        io.err(`Provider "${provider}" is not supported. Available: google, meta, tiktok, apple, microsoft, reddit, snapchat, spotify, pinterest, linkedin, x.`);
        process.exitCode = 1;
        return;
      }
      const removed = await new CredentialStore().delete(provider);
      if (!removed) {
        io.out(`No local ${provider} credentials were stored.`);
        return;
      }
      io.out(`Removed local ${provider} credentials.`);
      io.out('Provider-side access was not revoked. Revoke the token or key at the provider if needed.');
    });

  const recommendations = program.command('recommendations').description('Review and act on audit findings');

  recommendations
    .command('list', { isDefault: true })
    .description('List findings (default: open), most severe first')
    .option('--status <status>', 'open | dismissed | applied', 'open')
    .option('--json', 'JSON output')
    .action(async (opts: { status: string; json?: boolean }) => {
      const rt = await commandRuntime();
      const result = (await rt.registry.call('recommendations_list', { status: opts.status }, rt.ctx)) as {
        findings: Array<{ id: string; severity: string; title: string; recommendation: string; proposedAction?: unknown }>;
      };
      if (opts.json) {
        io.out(json(result.findings));
        return;
      }
      if (result.findings.length === 0) {
        io.out(`No ${opts.status} findings. Run: adport audit run`);
        return;
      }
      for (const f of result.findings) {
        io.out(`[${f.severity.toUpperCase()}] ${f.id}`);
        io.out(`  ${f.title}`);
        io.out(`  → ${f.recommendation}${f.proposedAction ? '  (has ready-to-apply action)' : ''}`);
      }
    });

  recommendations
    .command('apply <findingId>')
    .description('Run a finding\'s proposed action through the two-step validate→apply flow')
    .option('--pending <id>', 'pending_operation_id from the validation step')
    .action(async (findingId: string, opts: { pending?: string }) => {
      const rt = await commandRuntime();
      const result = await rt.registry.call(
        'recommendation_apply',
        { finding_id: findingId, pending_operation_id: opts.pending },
        rt.ctx,
      );
      io.out(json(result));
    });

  recommendations
    .command('dismiss <findingId>')
    .description('Dismiss a finding (never reopened by future runs)')
    .action(async (findingId: string) => {
      const rt = await commandRuntime();
      const result = await rt.registry.call('recommendation_dismiss', { finding_id: findingId }, rt.ctx);
      io.out(json(result));
    });

  program
    .command('doctor')
    .description('Check credential and connection health for every provider')
    .action(async () => {
      const store = new CredentialStore();
      const records = await store.list();
      const rt = await commandRuntime();
      io.out(`policy: ${rt.policySource}`);
      io.out(`providers loaded: ${rt.ctx.providers.list().map((p) => p.id).join(', ') || '(none)'}`);
      for (const record of records) {
        io.out(`${record.provider}: credentials stored (source: ${record.source}, updated ${record.updatedAt})`);
      }
      for (const id of ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const) {
        const provider = rt.ctx.providers.list().find((p) => p.id === id);
        if (!provider) {
          io.out(`${id}: not connected (run \`adport connect ${id}\`)`);
          continue;
        }
        try {
          const accounts = await provider.listAccounts();
          io.out(`${id}: OK — ${accounts.length} accessible account(s)`);
        } catch (err) {
          io.err(`${id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      }
    });

  program
    .command('mcp')
    .description('Start the adport MCP server on stdio')
    .action(async () => {
      const { runStdioServer } = await import('@adport/mcp');
      await runStdioServer(await commandRuntime());
      // Keep the process alive for the stdio transport.
      await new Promise(() => {});
    });

  return program;
}

export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof AdportError) {
      console.error(JSON.stringify(err.toJSON(), null, 2));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

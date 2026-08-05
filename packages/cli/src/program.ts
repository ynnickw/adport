import { Command } from 'commander';
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

async function runtime(): Promise<AdportRuntime> {
  const { assembleRuntime } = await import('@adport/mcp');
  return assembleRuntime();
}

export function buildProgram(io: ProgramIO = defaultIO): Command {
  const program = new Command('adport');
  program
    .description('Open-source multi-platform ads management for AI agents (MCP + CLI)')
    .version('0.0.1')
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) });

  const tools = program.command('tools').description('Inspect and invoke the shared tool registry');

  tools
    .command('list')
    .description('List available tools')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const { registry } = await runtime();
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
      const rt = await runtime();
      const result = await rt.registry.call(name, JSON.parse(opts.input), rt.ctx);
      io.out(json(result));
    });

  program
    .command('accounts')
    .description('List connected ad accounts across providers')
    .option('--provider <id>', 'Limit to one provider')
    .option('--json', 'JSON output')
    .action(async (opts: { provider?: string; json?: boolean }) => {
      const rt = await runtime();
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
      const rt = await runtime();
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
      const rt = await runtime();
      io.out(json({ source: rt.policySource, policy: rt.ctx.engine.policy }));
    });

  program
    .command('audit')
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
      if (provider === 'mock') {
        io.out('The mock provider needs no credentials — it is available out of the box. Try: adport accounts');
        return;
      }
      io.err(`Provider "${provider}" is not supported yet. Available: google, mock. Meta lands in M2, TikTok in v1.1.`);
      process.exitCode = 1;
    });

  program
    .command('doctor')
    .description('Check credential and connection health for every provider')
    .action(async () => {
      const store = new CredentialStore();
      const records = await store.list();
      const rt = await runtime();
      io.out(`policy: ${rt.policySource}`);
      io.out(`providers loaded: ${rt.ctx.providers.list().map((p) => p.id).join(', ') || '(none)'}`);
      for (const record of records) {
        io.out(`${record.provider}: credentials stored (source: ${record.source}, updated ${record.updatedAt})`);
      }
      const google = rt.ctx.providers.list().find((p) => p.id === 'google');
      if (google) {
        try {
          const accounts = await google.listAccounts();
          io.out(`google: OK — ${accounts.length} accessible account(s)`);
        } catch (err) {
          io.err(`google: FAILED — ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      } else {
        io.out('google: not connected (run `adport connect google`) — mock provider active');
      }
    });

  program
    .command('mcp')
    .description('Start the adport MCP server on stdio')
    .action(async () => {
      const { runStdioServer } = await import('@adport/mcp');
      await runStdioServer(await runtime());
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

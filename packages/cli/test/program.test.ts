import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram, type ProgramIO } from '../src/program.js';

let home: string;
let out: string[];
let err: string[];
let io: ProgramIO;

function run(...args: string[]) {
  const program = buildProgram(io);
  program.exitOverride();
  return program.parseAsync(['node', 'adport', ...args]);
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'adport-cli-test-'));
  process.env.ADPORT_HOME = home;
  // Never let the developer's real provider env credentials leak into tests.
  for (const key of Object.keys(process.env)) {
    if (/^(GOOGLE_ADS_|META_|TIKTOK_|APPLE_ADS_|MICROSOFT_ADS_)/.test(key)) delete process.env[key];
  }
  out = [];
  err = [];
  io = { out: (l) => out.push(l), err: (l) => err.push(l) };
});

afterEach(() => {
  delete process.env.ADPORT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('adport CLI', () => {
  it('lists tools as JSON', async () => {
    await run('tools', 'list', '--json');
    const tools = JSON.parse(out.join('\n')) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('accounts_list');
  });

  it('lists mock accounts', async () => {
    await run('accounts', '--json');
    const accounts = JSON.parse(out.join('\n')) as Array<{ id: string }>;
    expect(accounts.map((a) => a.id)).toEqual(['mock-1', 'mock-2']);
  });

  it('runs a report with human table output', async () => {
    await run('report', '--metrics', 'spend,clicks', '--range', 'last_7_days');
    expect(out.join('\n')).toContain('Brand Search');
  });

  it('runs the two-step write through tools run', async () => {
    await run('tools', 'run', 'mock_set_budget', '--input', '{"account_id":"mock-1","campaign_id":"c1","daily_budget_micros":11000000}');
    const first = JSON.parse(out.join('\n')) as { status: string; pending_operation_id: string };
    expect(first.status).toBe('pending_validation');

    out = [];
    await run(
      'tools',
      'run',
      'mock_set_budget',
      '--input',
      JSON.stringify({
        account_id: 'mock-1',
        campaign_id: 'c1',
        daily_budget_micros: 11_000_000,
        pending_operation_id: first.pending_operation_id,
      }),
    );
    const second = JSON.parse(out.join('\n')) as { status: string };
    expect(second.status).toBe('applied');
  });

  it('records and shows external-change audit notes', async () => {
    await run('audit', 'note', 'CPC ceiling set to 1.2M via direct API call', '--provider', 'google', '--account', '5622048100');
    expect(out).toContain('Noted.');
    out = [];
    await run('audit');
    const entry = JSON.parse(out.join('\n')) as { event: string; provider: string; summary: string };
    expect(entry.event).toBe('note');
    expect(entry.provider).toBe('google');
    expect(entry.summary).toContain('CPC ceiling');
  });

  it('runs the audit and lists + applies recommendations end-to-end', async () => {
    await run('audit', 'run');
    expect(out.join('\n')).toContain('zero-conversion-spend:mock:mock-1:c4');

    out = [];
    await run('recommendations', '--json');
    const findings = JSON.parse(out.join('\n')) as Array<{ id: string }>;
    const finding = findings.find((f) => f.id.startsWith('zero-conversion-spend'))!;

    out = [];
    await run('recommendations', 'apply', finding.id);
    const first = JSON.parse(out.join('\n')) as { result: { status: string; pending_operation_id: string } };
    expect(first.result.status).toBe('pending_validation');

    out = [];
    await run('recommendations', 'apply', finding.id, '--pending', first.result.pending_operation_id);
    const second = JSON.parse(out.join('\n')) as { result: { status: string } };
    expect(second.result.status).toBe('applied');
  });

  it('shows the policy with its source', async () => {
    await run('policy');
    const policy = JSON.parse(out.join('\n')) as { source: string; policy: { require_validation: boolean } };
    expect(policy.source).toBe('defaults');
    expect(policy.policy.require_validation).toBe(true);
  });
});

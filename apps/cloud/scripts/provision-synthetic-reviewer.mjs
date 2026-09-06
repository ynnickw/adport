// Administrative, explicitly invoked provisioning; never imported by the app.
// Usage: node provision-synthetic-reviewer.mjs <project-ref> <CLI-profile> <email> <private-output-file>
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSeed } from '@adport/core';

const [project, profile, email, output] = process.argv.slice(2);
const root = fileURLToPath(new URL('../../../', import.meta.url));
if (!/^[a-z]{20}$/.test(project ?? '') || !profile || !/^[a-z0-9.+_-]+@[a-z0-9.-]+$/i.test(email ?? '') || !output || !isAbsolute(output) || resolve(output).startsWith(root)) throw new Error('Provide project, CLI profile, valid reviewer email, and an absolute private output path outside the checkout.');
if (readFileSync(resolve(root, 'supabase/.temp/project-ref'), 'utf8').trim() !== project) throw new Error('Linked Supabase project does not match requested target.');
const cli = (...args) => JSON.parse(execFileSync('supabase', [...args, '--profile', profile, '-o', 'json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const query = sql => cli('db', 'query', '--linked', sql).rows;
if (!query("select to_regclass('private.synthetic_reviewer_workspaces') as marker")[0]?.marker) throw new Error('Apply the synthetic reviewer migration first.');
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
let credentials;
if (existsSync(output)) {
  credentials = JSON.parse(readFileSync(output, 'utf8'));
  if (credentials.project !== project || credentials.email !== email) throw new Error('Existing credential file belongs to another reviewer.');
} else {
  if (query(`select id from auth.users where email = '${email}'`).length) throw new Error('Reviewer already exists without the supplied recovery file. Refusing to change its password.');
  credentials = { project, email, password: randomBytes(32).toString('base64url'), login: 'https://app.adport.dev/', data_source: 'synthetic' };
  writeFileSync(output, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' });
}
chmodSync(output, 0o600);
const keys = cli('projects', 'api-keys', '--project-ref', project);
const key = keys.find(key => key.name === 'service_role')?.api_key;
if (!key) throw new Error('Supabase admin key unavailable.');
const existing = query(`select id from auth.users where email = '${email}'`);
if (!existing.length) {
  const response = await fetch(`https://${project}.supabase.co/auth/v1/admin/users`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: credentials.password, email_confirm: true, user_metadata: { full_name: 'Adport Synthetic Reviewer' } }),
  });
  if (!response.ok) throw new Error(`Reviewer creation failed (HTTP ${response.status}); no credential values logged.`);
  const user = await response.json(); credentials.userId = user.id;
} else credentials.userId = existing[0].id;
if (!/^[0-9a-f-]{36}$/.test(credentials.userId ?? '')) throw new Error('Unexpected reviewer user identifier.');
writeFileSync(output, JSON.stringify(credentials, null, 2), { mode: 0o600 });
// Verify the saved login before granting a plan or installing data.
const login = await fetch(`https://${project}.supabase.co/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: credentials.password }),
});
if (!login.ok) throw new Error(`Saved reviewer login could not be verified (HTTP ${login.status}).`);
const organizations = query(`select id from public.organizations where created_by = '${credentials.userId}'`);
if (organizations.length !== 1) throw new Error('Expected exactly one isolated reviewer organization.');
const organizationId = organizations[0].id;
if (!/^[0-9a-f-]{36}$/.test(organizationId)) throw new Error('Unexpected organization identifier.');
if (query(`select id from public.connections where organization_id = '${organizationId}'`).length) throw new Error('Reviewer organization already has real provider connections; refusing to repurpose it.');
query(`begin;
  update public.organizations set name = 'Adport Synthetic Reviewer' where id = '${organizationId}';
  update public.organization_subscriptions set plan = 'premium', status = 'active' where organization_id = '${organizationId}' and billing_provider is null;
  update public.organization_onboarding set current_step = 'complete', completed_at = now(), selected_agent = 'chatgpt' where organization_id = '${organizationId}';
  update public.organization_settings set policy = jsonb_set(jsonb_set(policy, '{require_validation}', 'true'), '{paused_creation}', 'true') where organization_id = '${organizationId}';
  insert into private.synthetic_reviewer_workspaces (organization_id, campaigns) values ('${organizationId}', '${JSON.stringify(syntheticSeed()).replaceAll("'", "''")}'::jsonb) on conflict (organization_id) do nothing;
  commit;`);
credentials.organizationId = organizationId;
credentials.instructions = 'Use normal Adport OAuth. Select this synthetic workspace. All demo campaigns remain paused. Demo tools are simulations, not proof of real advertising-provider approval. Share these credentials only through the platform private reviewer fields.';
writeFileSync(output, JSON.stringify(credentials, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ provisioned: true, organizationId, credentialsFile: output, next: 'Add organizationId to ADPORT_SYNTHETIC_REVIEWER_ORGANIZATION_IDS in the cloud server production environment and deploy.' }));

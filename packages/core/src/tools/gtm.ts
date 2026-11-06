import { z } from 'zod';
import { defineTool, type AnyToolDefinition } from './registry.js';
import { guardedWriteTool } from './write.js';

export const GTM_SCOPES = ['edit.containers', 'edit.containerversions', 'publish']
  .map(scope => `https://www.googleapis.com/auth/tagmanager.${scope}`);

const id = z.string().regex(/^\d+$/, 'Use the numeric GTM ID.');
const fingerprint = z.string().min(1).describe('Fingerprint returned by the latest read; changed resources require a new preview.');
const parameter = z.record(z.string(), z.unknown());
const parameters = z.array(parameter).max(200);
const condition = z.object({ type: z.string().min(1), parameter: parameters }).strict();
const common = { name: z.string().min(1).max(256), notes: z.string().optional(), parentFolderId: id.optional() };
const tag = z.object({
  ...common, type: z.string().min(1), parameter: parameters.optional(),
  firingTriggerId: z.array(id).optional(), blockingTriggerId: z.array(id).optional(),
  paused: z.boolean().optional(), liveOnly: z.boolean().optional(),
  tagFiringOption: z.enum(['unlimited', 'oncePerEvent', 'oncePerLoad']).optional(),
  consentSettings: parameter.optional(), setupTag: parameters.optional(), teardownTag: parameters.optional(),
  priority: parameter.optional(), scheduleStartMs: z.string().optional(), scheduleEndMs: z.string().optional(),
}).strict();
const trigger = z.object({
  ...common, type: z.string().min(1), parameter: parameters.optional(),
  customEventFilter: z.array(condition).optional(), filter: z.array(condition).optional(),
  autoEventFilter: z.array(condition).optional(), eventName: parameter.optional(),
  checkValidation: parameter.optional(), waitForTags: parameter.optional(), waitForTagsTimeout: parameter.optional(),
}).strict();
const variable = z.object({ ...common, type: z.string().min(1), parameter: parameters.optional(), formatValue: parameter.optional() }).strict();
const container = { container_id: id };
const workspace = { ...container, workspace_id: id };
const expected = { expected_fingerprint: fingerprint };

/** Native API-shaped configuration, defined once for CLI, MCP and provider validation. */
export const gtmWriteSchemas = {
  gtm_create_workspace: z.object({ ...container, name: common.name, description: z.string().optional() }),
  gtm_create_tag: z.object({ ...workspace, tag }),
  gtm_update_tag: z.object({ ...workspace, tag_id: id, ...expected, tag }),
  gtm_create_trigger: z.object({ ...workspace, trigger }),
  gtm_update_trigger: z.object({ ...workspace, trigger_id: id, ...expected, trigger }),
  gtm_create_variable: z.object({ ...workspace, variable }),
  gtm_update_variable: z.object({ ...workspace, variable_id: id, ...expected, variable }),
  gtm_create_version: z.object({ ...workspace, name: common.name, notes: z.string().optional(),
    expected_workspace_hash: z.string().regex(/^[a-f0-9]{64}$/).describe('workspace_hash from gtm_workspace_status; binds all pending workspace changes.') }),
  gtm_publish_version: z.object({ ...container, version_id: id, ...expected,
    expected_live_version_id: id.describe('Current published version ID, or 0 when this container has never been published.') }),
};

export interface GtmReader {
  read(accountId: string, suffix: string, query?: Record<string, string>): Promise<unknown>;
  workspaceStatus(accountId: string, containerId: string, workspaceId: string): Promise<unknown>;
}

export function gtmTools(provider: GtmReader): AnyToolDefinition[] {
  const account = { account_id: id };
  const page = { page_token: z.string().optional() };
  const read = (name: string, description: string, shape: z.ZodRawShape,
    suffix: (input: Record<string, string>) => string, paged = false) => defineTool({
    name, namespace: 'gtm', description, input: z.object({ ...account, ...shape }),
    annotations: { readOnly: true },
    handler: input => {
      const values = input as Record<string, string>;
      return provider.read(values.account_id!, suffix(values), paged && values.page_token ? { pageToken: values.page_token } : undefined);
    },
  });
  const tools: AnyToolDefinition[] = [
    read('gtm_list_containers', 'List Google Tag Manager containers in an enabled GTM account.', page, () => '/containers', true),
    read('gtm_get_container', 'Read container details, public GTM ID and supported features.', container, i => `/containers/${i.container_id}`),
    read('gtm_get_installation_snippet', 'Read the official GTM installation snippet for an existing container. Installing it requires website access.', container, i => `/containers/${i.container_id}:snippet`),
    read('gtm_list_workspaces', 'List container workspaces. Workspace changes are drafts until explicitly published.', { ...container, ...page }, i => `/containers/${i.container_id}/workspaces`, true),
    read('gtm_get_workspace', 'Read workspace metadata.', workspace, i => `/containers/${i.container_id}/workspaces/${i.workspace_id}`),
    read('gtm_list_versions', 'List saved version headers; use gtm_get_version for full configuration.', { ...container, ...page }, i => `/containers/${i.container_id}/version_headers`, true),
    read('gtm_get_version', 'Read a saved version, including tags, triggers, variables and templates. Configuration is not runtime analytics.', { ...container, version_id: id }, i => `/containers/${i.container_id}/versions/${i.version_id}`),
    read('gtm_get_live_version', 'Read the currently published container configuration. A never-published container may return 404.', container, i => `/containers/${i.container_id}/versions:live`),
    defineTool({ name: 'gtm_workspace_status', namespace: 'gtm', description: 'Read workspace changes and conflicts plus a workspace_hash required to create a version. Does not preview live website events.',
      input: z.object({ ...account, ...workspace }), annotations: { readOnly: true },
      handler: i => provider.workspaceStatus(i.account_id, i.container_id, i.workspace_id) }),
  ];
  for (const [entity, plural] of [['tag', 'tags'], ['trigger', 'triggers'], ['variable', 'variables']] as const) {
    const base = (i: Record<string, string>) => `/containers/${i.container_id}/workspaces/${i.workspace_id}/${plural}`;
    tools.push(
      read(`gtm_list_${plural}`, `Read GTM ${plural}, including configuration and fingerprints. Returns native nextPageToken when paginated.`, { ...workspace, ...page }, base, true),
      read(`gtm_get_${entity}`, `Read one GTM ${entity} and its fingerprint before editing.`, { ...workspace, [`${entity}_id`]: id }, i => `${base(i)}/${i[`${entity}_id`]}`),
    );
  }
  for (const [name, payload] of Object.entries(gtmWriteSchemas)) {
    const descriptions: Record<string, string> = {
      gtm_create_workspace: 'Create an isolated draft workspace in an existing container.',
      gtm_create_version: 'Save ALL workspace changes as a version; Google replaces the workspace. Requires a fresh workspace_hash and no conflicts. Does not publish.',
      gtm_publish_version: 'Publish a complete saved container version to the live website. Review the entire version first; separate explicit approval is required.',
    };
    tools.push(guardedWriteTool({ name, namespace: 'gtm', provider: 'gtm', kind: name.includes('_create_') ? 'create' : 'update',
      description: descriptions[name] ?? `${name.includes('_create_') ? 'Create' : 'Replace'} a draft GTM ${name.split('_').at(-1)} using native API fields. Updates replace supplied configuration; preserve existing fields. Does not publish.`, payload }));
  }
  return tools;
}

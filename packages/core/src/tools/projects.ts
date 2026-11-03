import { z } from 'zod';
import type { AdportRuntime } from '../context.js';
import { AdportError } from '../errors.js';
import { defineTool, ToolRegistry, type AnyToolDefinition } from './registry.js';

export interface AgentProject {
  id: string;
  name: string;
  organization_name: string;
  role: string;
  providers: string[];
}

export interface ProjectRouter {
  list: () => Promise<AgentProject[]>;
  resolve: (projectId: string, tool: AnyToolDefinition) => Promise<AdportRuntime>;
}

/** Reuse the same definitions and handlers, selecting an isolated runtime per call. */
export function withProjectRouting(runtime: AdportRuntime, router: ProjectRouter): AdportRuntime {
  const registry = new ToolRegistry();
  registry.register(defineTool({
    name: 'projects_list',
    namespace: 'core',
    description: 'List projects authorized for this connection and their connected platforms. Use a returned project id as project_id on other tools.',
    input: z.object({}),
    output: z.object({ projects: z.array(z.object({
      id: z.string().uuid(), name: z.string(), organization_name: z.string(), role: z.string(), providers: z.array(z.string()),
    })) }),
    annotations: { readOnly: true, openWorld: false },
    async handler() { return { projects: await router.list() }; },
  }));
  for (const tool of runtime.registry.list()) {
    registry.register({
      ...tool,
      input: tool.input.extend({
        project_id: z.string().uuid().optional().describe('Project id from projects_list. Required when this connection has access to multiple projects.'),
      }),
      async handler(input) {
        const { project_id, ...args } = input as Record<string, unknown>;
        let projectId = project_id as string | undefined;
        if (!projectId) {
          const projects = await router.list();
          if (projects.length !== 1) throw new AdportError('INVALID_INPUT', 'Choose a project_id from projects_list for this operation.', { projects });
          projectId = projects[0]!.id;
        }
        const target = await router.resolve(projectId, tool);
        return target.registry.call(tool.name, args, target.ctx);
      },
    });
  }
  // Authorization belongs to the resolved runtime, never the default project's context.
  return { ...runtime, registry, ctx: { ...runtime.ctx, registry, authorizeToolCall: undefined } };
}

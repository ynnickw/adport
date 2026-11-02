import 'server-only';
import { AdportError, withProjectRouting, type AdportRuntime } from '@adport/core';
import { applyPlanToPrincipal } from './plans';
import { adWritePlanLimit } from './write-plan-limit';
import { env } from '@/lib/env';
import { createTenantRuntime } from './runtime';
import type { TenantPrincipal } from './types';
import { listMcpProjects } from './mcp-oauth-repository';

export function routeMcpProjects(runtime: AdportRuntime, principal: TenantPrincipal): AdportRuntime {
  return withProjectRouting(runtime, {
    list: () => listMcpProjects(principal),
    async resolve(projectId, tool) {
      const project = (await listMcpProjects(principal)).find(project => project.id === projectId);
      if (!project) throw new AdportError('POLICY_VIOLATION', 'This connection does not have access to that project. Use projects_list to see available projects.');
      // Do not carry a role or plan filtered scope from a different project.
      const target = await applyPlanToPrincipal({
        ...principal, organizationId: project.id, role: undefined, entitlement: undefined,
        scopes: principal.grantedScopes ?? principal.scopes,
      });
      const scope = tool.annotations.readOnly ? 'tools:read' : 'tools:write';
      if (!target.scopes.includes(scope)) {
        const limit = !tool.annotations.readOnly ? await adWritePlanLimit(target, env().ADPORT_CLOUD_BASE_URL) : undefined;
        if (limit) throw new AdportError('PLAN_LIMIT', limit.message, { planLimit: limit });
        throw new AdportError('POLICY_VIOLATION', 'This connection does not have permission to perform this operation in the selected project.');
      }
      return createTenantRuntime(target, { surface: 'mcp' });
    },
  });
}

import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AdportRuntime } from '@adport/core';
import { captureProductEvent } from './product-analytics';
import type { TenantPrincipal } from './types';
import { recordAssistantRead } from './assistant-connection';

const insideTool = new AsyncLocalStorage<boolean>();

/** Wrap this hosted instance only. The core registry and local adapters stay telemetry free. */
export function instrumentCloudTools(runtime: AdportRuntime, principal: TenantPrincipal, surface: 'dashboard' | 'mcp' | 'api'): AdportRuntime {
  const call = runtime.registry.call.bind(runtime.registry);
  runtime.registry.call = async (name, input, ctx) => {
    if (insideTool.getStore()) return call(name, input, ctx);
    const tool = runtime.registry.get(name);
    if (['gtm', 'ga4', 'gsc'].includes(tool.namespace)) return call(name, input, ctx);
    const apply = input !== null && typeof input === 'object' && 'pending_operation_id' in input && Boolean(input.pending_operation_id);
    const category = !tool.annotations.readOnly ? (apply ? 'write_apply' : 'write_preview')
      : name === 'report' ? 'report' : tool.namespace === 'audit' ? 'audit' : 'read';
    return insideTool.run(true, async () => {
      try {
        const result = await call(name, input, ctx);
        const value = result as { status?: string; errors?: unknown[] } | null;
        // A preview is not an applied change, and partial provider failures are not success.
        if (value?.errors?.length) captureProductEvent(principal, { event: 'tool_failed', category, surface, reason: 'provider' });
        else if (tool.annotations.readOnly || value?.status === 'applied' || value?.status === 'pending_validation') {
          const completedCategory = tool.annotations.readOnly ? category : value?.status === 'applied' ? 'write_apply' : 'write_preview';
          captureProductEvent(principal, { event: 'tool_completed', category: completedCategory, surface });
          // Count only data reads through the assistant transport. Empty account
          // discovery, partial errors, previews and dashboard reads do not verify setup.
          const data = result as { accounts?: unknown[]; rows?: unknown[]; data_source?: string } | null;
          if (surface === 'mcp' && runtime.dataSource !== 'synthetic' && tool.annotations.readOnly && data?.data_source !== 'synthetic'
            && ((name === 'report' && Boolean(data?.rows?.length)) || (name === 'accounts_list' && Boolean(data?.accounts?.length)))) {
            try { await recordAssistantRead(principal); }
            catch { console.error('Could not record assistant connection verification.'); }
          }
        }
        return result;
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const reason = code?.startsWith('PENDING_') || code === 'POLICY_VIOLATION' ? 'policy'
          : code === 'INVALID_INPUT' ? 'invalid_input' : code === 'PROVIDER_ERROR' ? 'provider' : 'other';
        captureProductEvent(principal, { event: 'tool_failed', category, surface, reason });
        throw error;
      }
    });
  };
  return runtime;
}

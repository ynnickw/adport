import { z } from 'zod';
import type { CredentialRepository } from '../credentials/store.js';
import type { FindingsRepository } from '../audit/store.js';
import { AdportError } from '../errors.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { ProviderRegistry } from '../provider.js';

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
}

export interface ToolContext {
  providers: ProviderRegistry;
  engine: PolicyEngine;
  credentials: CredentialRepository;
  findings: FindingsRepository;
  /** Set by createContext; lets tools invoke other tools (e.g. recommendation_apply). */
  registry?: ToolRegistry;
}

export interface AnyToolDefinition {
  name: string;
  /** Grouping key used for config-based enable/disable ("core", "mock", "google", ...). */
  namespace: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  annotations: ToolAnnotations;
  handler: (input: never, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(def: {
  name: string;
  namespace: string;
  description: string;
  input: S;
  annotations?: ToolAnnotations;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}): AnyToolDefinition {
  return {
    ...def,
    annotations: def.annotations ?? { readOnly: false },
  } as AnyToolDefinition;
}

export class ToolRegistry {
  private tools = new Map<string, AnyToolDefinition>();

  register(tools: AnyToolDefinition | AnyToolDefinition[]): void {
    for (const tool of Array.isArray(tools) ? tools : [tools]) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  list(): AnyToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): AnyToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new AdportError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    return tool;
  }

  async call(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name);
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw new AdportError('INVALID_INPUT', `Invalid input for ${name}`, parsed.error.issues);
    }
    return tool.handler(parsed.data as never, ctx);
  }
}

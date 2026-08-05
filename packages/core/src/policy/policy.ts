import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { adportHome } from '../paths.js';

export const policySchema = z.object({
  /** Writes must be validated (dry-run) before they can be applied. */
  require_validation: z.boolean().default(true),
  /** Created campaigns/ad groups/ads are coerced to PAUSED. */
  paused_creation: z.boolean().default(true),
  /** Reject budget changes exceeding this percentage of the current value. null = no cap. */
  max_budget_delta_pct: z.number().positive().nullable().default(25),
  /** Reject any budget set above this absolute value (micros). null = no cap. */
  max_daily_budget_micros: z.number().positive().nullable().default(null),
  /** Account ids that no write may touch. */
  protected_accounts: z.array(z.string()).default([]),
  /** How long a validated pending operation stays applicable. */
  pending_ttl_minutes: z.number().positive().default(15),
});

export type Policy = z.infer<typeof policySchema>;

export const DEFAULT_POLICY: Policy = policySchema.parse({});

export interface LoadedPolicy {
  policy: Policy;
  /** Where the policy came from: a file path or "defaults". */
  source: string;
}

/**
 * Resolution order: explicit path → $ADPORT_POLICY → ./adport.policy.yaml →
 * ${ADPORT_HOME}/policy.yaml → built-in defaults.
 * A file that exists but fails validation is a hard error — never silently
 * fall back to weaker rails.
 */
export async function loadPolicy(explicitPath?: string): Promise<LoadedPolicy> {
  const candidates = [
    explicitPath,
    process.env.ADPORT_POLICY,
    path.join(process.cwd(), 'adport.policy.yaml'),
    path.join(adportHome(), 'policy.yaml'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = await fs.readFile(candidate, 'utf8');
    } catch {
      if (candidate === explicitPath || candidate === process.env.ADPORT_POLICY) {
        throw new Error(`Policy file not found: ${candidate}`);
      }
      continue;
    }
    const parsed = policySchema.safeParse(YAML.parse(raw) ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid policy file ${candidate}: ${parsed.error.message}`);
    }
    return { policy: parsed.data, source: candidate };
  }
  return { policy: DEFAULT_POLICY, source: 'defaults' };
}

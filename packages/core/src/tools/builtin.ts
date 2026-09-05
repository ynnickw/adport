import { z } from 'zod';
import { DATE_PRESETS, ENTITY_LEVELS, METRICS, type NormalizedQuery, type ReportRow } from '../model.js';
import { selectConnectedProviders, type Account } from '../provider.js';
import { AdportError } from '../errors.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const dateRangeSchema = z.union([
  z.enum(DATE_PRESETS),
  z.object({
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  }),
]);

function canonicalAccountId(provider: string, id: string): string {
  if (provider === 'google') return id.replaceAll('-', '');
  if (provider === 'meta') return id.replace(/^act_/, '');
  return id;
}

export function builtinTools(): AnyToolDefinition[] {
  return [
    defineTool({
      name: 'accounts_list',
      namespace: 'core',
      description: 'List connected ad accounts across all providers (or one provider).',
      input: z.object({
        provider: z.string().optional().describe('Limit to one provider id, e.g. "google".'),
        continue_on_error: z.boolean().default(false).describe('Return successful providers plus per-provider errors instead of failing the whole read.'),
      }),
      annotations: { readOnly: true, openWorld: true },
      async handler(input, ctx) {
        const providers = selectConnectedProviders(ctx.providers, input.provider);
        const accounts: Account[] = [];
        const errors: Array<{ provider: string; message: string }> = [];
        for (const provider of providers) {
          try {
            accounts.push(...(await provider.listAccounts()));
          } catch (error) {
            if (!input.continue_on_error) throw error;
            errors.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return { accounts, errors };
      },
    }),
    defineTool({
      name: 'report',
      namespace: 'core',
      description:
        'Cross-platform performance report with normalized metrics (spend, clicks, conversions, ROAS, ...). ' +
        'Rows are capped by `limit`; the response says when it truncated.',
      input: z.object({
        provider: z.string().optional().describe('Limit to one provider id.'),
        account_ids: z.array(z.string()).optional().describe('Filter to available accounts. Cross-provider requests route each ID only to its matching provider; set provider to disambiguate shared IDs.'),
        level: z.enum(ENTITY_LEVELS).default('campaign'),
        metrics: z.array(z.enum(METRICS)).min(1).default(['spend', 'impressions', 'clicks', 'conversions']),
        date_range: dateRangeSchema.default('last_7_days'),
        limit: z.number().int().positive().max(1000).default(100),
        continue_on_error: z.boolean().default(false).describe('Return successful providers plus per-provider errors instead of failing the whole read.'),
      }),
      annotations: { readOnly: true, openWorld: true },
      async handler(input, ctx) {
        const providers = selectConnectedProviders(ctx.providers, input.provider);
        const query: NormalizedQuery = {
          accountIds: input.account_ids,
          level: input.level,
          metrics: input.metrics,
          dateRange: input.date_range,
          limit: input.limit,
        };
        const rows: ReportRow[] = [];
        const errors: Array<{ provider: string; message: string }> = [];
        const warnings: Array<{ provider: string; message: string }> = [];
        const accountMetadata = new Map<string, Account[]>();
        const routedIds = new Map<string, string[]>();
        const failedDiscovery = new Set<string>();
        if (input.account_ids && !input.provider) {
          // Never fan out one provider's IDs to another provider. Resolve first,
          // then retain the provider's own account-scope authorization on reads.
          const matched = new Set<string>();
          for (const provider of providers) {
            try {
              const accounts = (await provider.listAccounts()).filter((a) => a.provider === provider.id);
              accountMetadata.set(provider.id, accounts);
              const ids: string[] = [];
              for (const requested of input.account_ids) {
                const account = accounts.find((a) => canonicalAccountId(provider.id, requested) === canonicalAccountId(provider.id, a.id));
                if (account) { matched.add(requested); ids.push(account.id); }
              }
              routedIds.set(provider.id, [...new Set(ids)]);
            } catch (error) {
              if (!input.continue_on_error) throw error;
              failedDiscovery.add(provider.id);
              errors.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) });
            }
          }
          if (input.account_ids.some((id) => !matched.has(id))) {
            const error = new AdportError('INVALID_INPUT', 'Some requested accounts could not be resolved in the connected providers. Use accounts_list and select available account IDs.');
            if (!input.continue_on_error) throw error;
            errors.push({ provider: 'core', message: error.message });
          }
        }
        let providerTruncated = false;
        for (const provider of providers) {
          if (failedDiscovery.has(provider.id)) continue;
          const accountIds = routedIds.get(provider.id) ?? query.accountIds;
          if (accountIds?.length === 0) continue;
          try {
            const report = await provider.report({ ...query, accountIds });
            providerTruncated ||= report.truncated === true;
            let accounts: Account[] = accountMetadata.get(provider.id) ?? [];
            if (!accountMetadata.has(provider.id) && report.rows.some((row) => !row.currency)) {
              try {
                accounts = await provider.listAccounts();
              } catch {
                // Reporting can succeed even if account metadata is unavailable.
                warnings.push({ provider: provider.id, message: 'Account currency lookup failed; unlabelled monetary values must remain separated by account.' });
              }
            }
            const currencies = new Map(accounts.filter((a) => a.provider === provider.id).map((a) => [a.id, a.currency]));
            rows.push(...report.rows.map((row) => {
              const currency = row.currency || currencies.get(row.accountId);
              return currency ? { ...row, currency } : row;
            }));
          } catch (error) {
            if (!input.continue_on_error) throw error;
            errors.push({ provider: provider.id, message: error instanceof Error ? error.message : String(error) });
          }
        }
        const truncated = providerTruncated || rows.length > input.limit;
        return { rows: rows.slice(0, input.limit), truncated, errors, warnings, date_range: input.date_range };
      },
    }),
  ];
}

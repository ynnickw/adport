import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, policySchema } from '@adport/core';
import { PolicyForm } from '@/app/dashboard/policies/policy-form';
import { PolicySummary } from '@/components/policy-summary';
import { createPolicySettingsDraft, policySettingsInput } from '@/lib/policy-settings';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/app/dashboard/agents/agent-setup-guide', () => ({ AgentSetupGuide: () => <div>Assistant setup fixture</div> }));

describe('optional policy settings', () => {
  it('turns off both limits without disabling previews or losing other safeguards', () => {
    const draft = createPolicySettingsDraft({ ...DEFAULT_POLICY, max_daily_budget_micros: 50_000_000, protected_accounts: ['google-1', 'absent'] }, 30, ['google-1']);
    draft.budgetChangeEnabled = false;
    draft.dailyBudgetEnabled = false;
    const input = policySettingsInput(draft);
    expect(input.policy).toEqual({ ...DEFAULT_POLICY, max_budget_delta_pct: null, max_daily_budget_micros: null, protected_accounts: ['absent', 'google-1'] });
    expect(policySchema.safeParse(input.policy).success).toBe(true);
    draft.budgetChangeEnabled = true;
    draft.dailyBudgetEnabled = true;
    expect(policySettingsInput(draft).policy).toMatchObject({ max_budget_delta_pct: 25, max_daily_budget_micros: 50_000_000 });
  });

  it('requires an amount when a previously unlimited daily budget is enabled', () => {
    const draft = createPolicySettingsDraft(DEFAULT_POLICY, 30, []);
    draft.dailyBudgetEnabled = true;
    expect(policySchema.safeParse(policySettingsInput(draft).policy).success).toBe(false);
    draft.dailyBudget = '10.25';
    expect(policySettingsInput(draft).policy.max_daily_budget_micros).toBe(10_250_000);
  });

  it('preserves undiscovered protected accounts when another account is unchecked', () => {
    const draft = createPolicySettingsDraft({ ...DEFAULT_POLICY, protected_accounts: ['google-1', 'absent'] }, 30, ['google-1']);
    draft.protectedAccounts = [];
    draft.otherAccountIds += ', absent, other, ';
    expect(policySettingsInput(draft).policy.protected_accounts).toEqual(['absent', 'other']);
  });

  it('renders named switches, explicit unlimited states, account access, and custom info controls', () => {
    const html = renderToStaticMarkup(<PolicyForm organizationId="project" canAdminister policy={{ ...DEFAULT_POLICY, max_budget_delta_pct: null, protected_accounts: ['readonly'] }} dataRetentionDays={30} planName="Growth" maxRetentionDays={90} writeAccess accounts={[
      { provider: 'google', accountId: 'readonly', name: 'Read account', currency: 'EUR', status: null, enabled: true },
      { provider: 'meta', accountId: 'editable', name: 'Edit account', currency: 'USD', status: null, enabled: true },
      { provider: 'apple', accountId: 'disabled', name: 'Disabled account', currency: 'EUR', status: null, enabled: false },
    ]} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('No percentage limit');
    expect(html).toContain('No daily budget limit');
    expect(html).not.toContain('name="maxBudgetDeltaPct"');
    expect(html).not.toContain('name="maxDailyBudget"');
    expect(html).toContain('Read only</span>');
    expect(html).toContain('Preview required</span>');
    expect(html).toContain('Disabled</span>');
    expect(html).toContain('aria-label="About budget limits"');
    expect(html).toContain('All changes saved');
    expect(html).toContain('Discard</button>');
    expect(html).not.toContain('name="require_validation"');
  });
});

describe('onboarding safety summary', () => {
  it('shows the current saved policy rather than assuming the defaults', () => {
    const html = renderToStaticMarkup(<PolicySummary policy={{ ...DEFAULT_POLICY, paused_creation: false, max_budget_delta_pct: null, max_daily_budget_micros: 125_500_000 }} settingsHref="/dashboard/policies?setup=1" />);
    expect(html).toContain('Preview required');
    expect(html).toContain('Use requested status');
    expect(html).toContain('No limit');
    expect(html).toContain('125.5');
    expect(html).not.toContain('25%');
    expect(html).toContain('href="/dashboard/policies?setup=1"');
  });

  it('appears before assistant setup and carries the dashboard return path to Customize', () => {
    const html = renderToStaticMarkup(<OnboardingFlow policy={DEFAULT_POLICY} projectName="Client" setupKind="first_project" organizationId="project" canManage initialStep="agent" initialAgent={null} baseUrl="https://app.adport.test" providers={[]} connections={[]} accounts={[]} maxActiveAccounts={3} organizationActiveCount={0} returnTo="/dashboard/agents" />);
    expect(html).toContain('Project safeguards');
    expect(html).toContain('Start paused');
    expect(html).toContain('25%');
    expect(html.indexOf('Project safeguards')).toBeLessThan(html.indexOf('Assistant setup fixture'));
    expect(html).toContain('href="/dashboard/policies?setup=1&amp;return_to=%2Fdashboard%2Fagents"');
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, policySchema } from '@adport/core';
import { PolicyForm } from '@/app/dashboard/policies/policy-form';
import { PolicySummary } from '@/components/policy-summary';
import { createPolicySettingsDraft, policySettingsInput } from '@/lib/policy-settings';
import { OnboardingFlow } from '@/app/onboarding/onboarding-flow';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/assistant-connect', () => ({ AssistantConnect: () => <div>Assistant setup fixture</div>, AssistantPicker: () => <div /> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const accounts = [
  { provider: 'google', accountId: 'readonly', name: 'Read account', currency: 'EUR', status: null, enabled: true },
  { provider: 'meta', accountId: 'editable', name: 'Edit account', currency: 'USD', status: null, enabled: true },
  { provider: 'apple', accountId: 'disabled', name: 'Disabled account', currency: 'EUR', status: null, enabled: false },
];

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
    const html = renderToStaticMarkup(<PolicyForm organizationId="project" canAdminister policy={{ ...DEFAULT_POLICY, max_budget_delta_pct: null, protected_accounts: ['readonly'] }} dataRetentionDays={30} planName="Growth" maxRetentionDays={90} writeAccess accounts={accounts} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('No percentage limit');
    expect(html).toContain('No daily budget limit');
    expect(html).not.toContain('name="maxBudgetDeltaPct"');
    expect(html).not.toContain('name="maxDailyBudget"');
    expect(html).toContain('aria-label="About budget limits"');
    expect(html).toContain('1 selected');
    expect(html).toContain('Choose accounts');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Discard</button>');
    expect(html).not.toContain('Save policy');
    expect(html).not.toContain('name="require_validation"');
  });

  it('reviews account choices locally and applies them only when the policy is saved', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal('fetch', fetch);
    render(<PolicyForm organizationId="project" canAdminister policy={{ ...DEFAULT_POLICY, protected_accounts: ['readonly'] }}
      dataRetentionDays={30} planName="Growth" maxRetentionDays={90} writeAccess accounts={accounts} />);
    const choose = screen.getByRole('button', { name: 'Choose accounts' });
    fireEvent.click(choose);
    let dialog = within(screen.getByRole('dialog', { name: 'Read-only accounts' }));
    expect(dialog.getByText('Read only')).toBeTruthy();
    expect(dialog.getByText('Preview required')).toBeTruthy();
    expect(dialog.getByText('Disabled')).toBeTruthy();
    fireEvent.click(dialog.getByRole('checkbox', { name: 'Make Edit account read only' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('1 selected')).toBeTruthy();

    fireEvent.click(choose);
    dialog = within(screen.getByRole('dialog', { name: 'Read-only accounts' }));
    const account = dialog.getByRole('checkbox', { name: 'Make Edit account read only' });
    expect(account).toHaveProperty('checked', false);
    fireEvent.click(account);
    fireEvent.change(dialog.getByRole('textbox', { name: 'Other account IDs' }), { target: { value: 'unlisted' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('3 selected')).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
      organizationId: 'project', policy: { protected_accounts: ['editable', 'readonly', 'unlisted'], require_validation: true },
    });
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

  it('keeps assistant setup focused without the safety banner', () => {
    const html = renderToStaticMarkup(<OnboardingFlow projectName="Client" setupKind="first_project" organizationId="project" canManage initialStep="agent" initialAgent={null} baseUrl="https://app.adport.test" providers={[]} connections={[]} accounts={[]} maxActiveAccounts={3} organizationActiveCount={0} returnTo="/dashboard/agents" />);
    expect(html).toContain('Assistant setup fixture');
    expect(html).not.toContain('Preview required for every ad change');
    expect(html).not.toContain('Project safeguards');
    expect(html).not.toContain('Safety settings');
  });
});

export const SETUP_STEPS = [
  { id: 'connect', label: 'Platform' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'agent', label: 'Assistant' },
] as const;

export type SetupStep = typeof SETUP_STEPS[number]['id'];

export function SetupProgress({ step, completed }: { step: SetupStep; completed: Record<SetupStep, boolean> }) {
  return <ol className="setup-progress" aria-label="Project setup progress">
    {SETUP_STEPS.map(({ id, label }, index) => <li key={id} aria-current={step === id ? 'step' : undefined} data-complete={completed[id]}>
      <span className="setup-progress-number" aria-hidden="true">{step !== id && completed[id] ? '✓' : index + 1}</span>
      <span>{label}{completed[id] ? <span className="sr-only"> complete</span> : null}</span>
    </li>)}
  </ol>;
}

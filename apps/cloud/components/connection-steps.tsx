export function ConnectionSteps({ active, resources }: { active?: 'sign-in' | 'choose' | 'save'; resources: string }) {
  return <ol className="provider-handoff-steps" aria-label="Connection steps">
    <li aria-current={active === 'sign-in' ? 'step' : undefined}>{active === 'choose' || active === 'save' ? <span aria-hidden="true">✓ </span> : null}Sign in</li>
    <li aria-current={active === 'choose' ? 'step' : undefined}>Choose {resources}</li>
    <li aria-current={active === 'save' ? 'step' : undefined}>Save</li>
  </ol>;
}

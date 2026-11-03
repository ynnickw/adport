'use client';

import { Fragment, useState, type ComponentProps } from 'react';
import { PAID_PLAN_IDS, PricingComparison } from './pricing-comparison';

type Interval = 'monthly' | 'annual';
type PricingProps = ComponentProps<typeof PricingComparison>;
type Props = Pick<PricingProps, 'currentPlanId' | 'requestedPlan' | 'canManageBilling' | 'freeAction' | 'context'> & {
  initialInterval: Interval;
  billingLinks: Record<Interval, string>;
  actions: Record<Interval, PricingProps['actions']>;
  notes: Record<Interval, PricingProps['notes']>;
};

export function DashboardPricing({ initialInterval, billingLinks, actions, notes, ...comparison }: Props) {
  const [interval, setInterval] = useState(initialInterval);
  function selectInterval(next: Interval) {
    if (next === interval) return;
    setInterval(next);
    window.history.replaceState(null, '', billingLinks[next]);
  }
  const selectedActions: PricingProps['actions'] = {};
  // Each interval has its own server action and form state.
  for (const id of PAID_PLAN_IDS) selectedActions[id] = <Fragment key={interval}>{actions[interval][id]}</Fragment>;
  return <div className="dashboard-pricing">
    <PricingComparison {...comparison} variant="dashboard" interval={interval} onIntervalChange={selectInterval} actions={selectedActions} notes={notes[interval]} />
  </div>;
}

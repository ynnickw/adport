'use client';

import { useState } from 'react';
import { Button } from './controls';
import { PlanLimitModal } from './plan-limit-modal';
import { useUpgradeContext } from './upgrade-context';
import { recommendUpgradePlan, type PlanLimitDetails, type PlanLimitKind, type PlanRequirements } from '@/lib/cloud/plan-limit';
import catalog from '@/lib/cloud/plan-catalog.json';

export function UpgradeButton({ kind, message, required, label, className = 'inline-upgrade-button', disabled }: {
  kind: PlanLimitKind; message: string; required?: number; label?: string; className?: string; disabled?: boolean;
}) {
  const context = useUpgradeContext();
  const [open, setOpen] = useState(false);
  const requirements: PlanRequirements = kind === 'active_accounts' ? { activeAccounts: required }
    : kind === 'members' ? { members: required } : kind === 'retention' ? { retentionDays: required } : { writeAccess: true };
  const limit: PlanLimitDetails = { kind, message, currentPlan: catalog[context.planId].name, recommendedPlan: recommendUpgradePlan(context.planId, requirements) };
  return <><Button className={className} type="button" disabled={disabled} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}>{label ?? 'Compare plans'}</Button>{open ? <PlanLimitModal limit={limit} onClose={() => setOpen(false)} /> : null}</>;
}

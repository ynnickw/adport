'use client';

import { useState } from 'react';
import { Button } from './controls';
import { PlanLimitModal } from './plan-limit-modal';
import { useUpgradeContext } from './upgrade-context';
import { recommendUpgradePlan, type PlanLimitDetails, type PlanLimitKind, type PlanRequirements } from '@/lib/cloud/plan-limit';
import catalog from '@/lib/cloud/plan-catalog.json';

export function UpgradeButton({ kind, message, required, label, className = 'inline-upgrade-button' }: {
  kind: PlanLimitKind; message: string; required?: number; label?: string; className?: string;
}) {
  const context = useUpgradeContext();
  const [open, setOpen] = useState(false);
  const requirements: PlanRequirements = kind === 'active_accounts' ? { activeAccounts: required }
    : kind === 'members' ? { members: required } : kind === 'retention' ? { retentionDays: required } : { writeAccess: true };
  const limit: PlanLimitDetails = { kind, message, currentPlan: catalog[context.planId].name, recommendedPlan: recommendUpgradePlan(context.planId, requirements) };
  return <><Button className={className} type="button" onClick={() => setOpen(true)}>{label ?? (context.canManageBilling ? 'Upgrade your plan' : 'View upgrade options')}</Button>{open ? <PlanLimitModal limit={limit} onClose={() => setOpen(false)} /> : null}</>;
}

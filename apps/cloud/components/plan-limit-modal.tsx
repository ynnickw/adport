'use client';

import Link from 'next/link';
import { Button } from './controls';
import { Dialog } from './dialog';
import type { PlanLimitDetails } from '@/lib/cloud/plan-limit';

const TITLES = { active_accounts: 'Account limit reached', members: 'Editing member limit reached', retention: 'Retention limit reached' } as const;
const PLAN_NAMES = { operator: 'Pro', premium: 'Growth', agency: 'Agency', enterprise: 'Enterprise' } as const;

export function PlanLimitModal({ limit, onClose }: { limit?: PlanLimitDetails; onClose: () => void }) {
  if (!limit) return null;
  return <Dialog title={TITLES[limit.kind]} onClose={onClose}>
    <p className="dialog-description">{limit.message}</p>
    <p className="inline-note">Recommended: {PLAN_NAMES[limit.recommendedPlan]}</p>
    <div className="modal-actions"><Button className="button secondary" type="button" onClick={onClose}>Not now</Button><Link className="button" href={`/dashboard/billing?intent=${limit.kind}`}>View plans</Link></div>
  </Dialog>;
}

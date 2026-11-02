'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from './controls';
import { Dialog } from './dialog';
import { billingUpgradePath, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import catalog from '@/lib/cloud/plan-catalog.json';
import { PlanCard } from './plan-card';
import { useUpgradeContext } from './upgrade-context';

const TITLES = { active_accounts: 'Enable more ad accounts', members: 'Make room for your team', retention: 'Keep a longer audit history', write_access: 'Put your ad insights into action' } as const;

export function PlanLimitModal({ limit, onClose }: { limit?: PlanLimitDetails; onClose: () => void }) {
  return limit ? <UpgradeDialog key={`${limit.kind}:${limit.recommendedPlan}:${limit.message}`} limit={limit} onClose={onClose} /> : null;
}

function UpgradeDialog({ limit, onClose }: { limit: PlanLimitDetails; onClose: () => void }) {
  const context = useUpgradeContext();
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const canManage = context.canManageBilling;
  const path = billingUpgradePath({ ...limit, projectId: context.projectId ?? limit.projectId });
  const plan = catalog[limit.recommendedPlan];
  return <Dialog title={TITLES[limit.kind]} onClose={onClose} className="upgrade-dialog pricing-surface">
    <p className="dialog-description">{limit.message}</p>
    <PlanCard planId={limit.recommendedPlan} featured compact badge="Recommended" />
    {!canManage ? <p className="upgrade-owner-note">Your organization owner manages the plan. Share this upgrade link with them; your current access stays available.</p> : null}
    <div className="modal-actions"><Button className="button secondary" type="button" onClick={onClose}>Not now</Button>{canManage ? <Link className="pricing-action pricing-action-primary" href={path}>{limit.recommendedPlan === 'enterprise' ? 'Explore Enterprise' : `View ${plan.name} plan`} <span aria-hidden="true">→</span></Link> : <><Link className="button secondary" href={path}>View plan details</Link><Button className="pricing-action pricing-action-primary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(new URL(path, window.location.origin).href); setCopyStatus('copied'); } catch { setCopyStatus('failed'); } }}><span aria-live="polite">{copyStatus === 'copied' ? 'Link copied ✓' : 'Copy upgrade link'}</span></Button></>}</div>
    {copyStatus === 'failed' ? <p className="field-error" role="alert">Copying is unavailable. Open plan details and share that page’s address with your owner.</p> : null}
  </Dialog>;
}

'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { PlanLimitDetails } from '@/lib/cloud/plan-limit';

const COPY = {
  active_accounts: {
    eyebrow: 'Account limit reached',
    title: 'Bring every ad account into Adport',
    points: ['Activate more connected ad accounts', 'Keep one governed account inventory', 'Change plans without reconnecting providers'],
  },
  members: {
    eyebrow: 'Team limit reached',
    title: 'Give your team governed access',
    points: ['Invite more workspace members', 'Assign admin, member, and viewer roles', 'Keep every change in the audit log'],
  },
  retention: {
    eyebrow: 'Retention limit reached',
    title: 'Keep a longer audit history',
    points: ['Retain evidence for longer', 'Review historical approvals and changes', 'Support client and compliance workflows'],
  },
} as const;

const PLAN_NAMES = { operator: 'Operator', agency: 'Agency', enterprise: 'Enterprise' } as const;

export function PlanLimitModal({ limit, onClose }: { limit?: PlanLimitDetails; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!limit) return;
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [limit, onClose]);
  if (!limit) return null;
  const copy = COPY[limit.kind];
  const planName = PLAN_NAMES[limit.recommendedPlan];
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="upgrade-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-modal-title" aria-describedby="upgrade-modal-copy">
        <button ref={closeButton} className="modal-close" type="button" onClick={onClose} aria-label="Close upgrade dialog">×</button>
        <span className="plan-kicker">{copy.eyebrow}</span>
        <h2 id="upgrade-modal-title">{copy.title}</h2>
        <p id="upgrade-modal-copy">{limit.message}</p>
        <div className="upgrade-plan-line"><span>Recommended</span><strong>{planName}</strong></div>
        <ul>{copy.points.map((point) => <li key={point}>{point}</li>)}</ul>
        <div className="modal-actions">
          <Link className="button" href={`/dashboard/billing?intent=${limit.kind}`}>Compare plans</Link>
          <button className="button secondary" type="button" onClick={onClose}>Not now</button>
        </div>
      </section>
    </div>
  );
}

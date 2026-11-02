'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from './controls';
import { InfoTooltip } from './info-tooltip';

export function SetupChecklist({ userId, projectId, projectName, connected, accountsEnabled, assistantVerified }: {
  userId: string; projectId: string; projectName: string; connected: boolean; accountsEnabled: boolean; assistantVerified: boolean;
}) {
  const key = `adport:setup-dismissed:${userId}:${projectId}`;
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try { setDismissed(localStorage.getItem(key) === '1'); }
    catch { setDismissed(false); }
  }, [key]);
  if (dismissed) return null;
  const ready = connected && accountsEnabled && assistantVerified;
  return <section className="setup-checklist" aria-label="Project setup">
    <div className="setup-checklist-heading"><div><h2>{ready ? 'Your first read is verified' : 'Get your first answer'} <InfoTooltip label="About this setup checklist">Setup is verified after your assistant successfully reads an account list or report in this project. You can hide this checklist on this browser and return through Connect assistant anytime.</InfoTooltip></h2><p>{projectName} · {ready ? 'Finish setup when you’re ready.' : 'Pick up where you left off.'}</p></div><Button type="button" className="icon-button" aria-label="Dismiss setup checklist" onClick={() => { try { localStorage.setItem(key, '1'); } catch { /* Dismiss for this session if storage is unavailable. */ } setDismissed(true); }}>×</Button></div>
    <div className="setup-checklist-content"><ol>{[['Platform connected', connected], ['Accounts enabled', accountsEnabled], ['Assistant read verified', assistantVerified]].map(([label, done]) => <li key={String(label)} data-complete={done}><span aria-hidden="true">{done ? '✓' : '○'}</span>{label}</li>)}</ol><Link href={'/onboarding?' + new URLSearchParams({ resume: '1', step: !connected ? 'connect' : !accountsEnabled ? 'accounts' : 'agent' })} className="button secondary small">{ready ? 'Finish setup' : 'Continue setup'}</Link></div>
  </section>;
}

'use client';

import { Button, Input, Textarea } from '@/components/controls';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from './dialog';
import { Select } from './select';

export const SUPPORT_OPEN_EVENT = 'adport:support-open';

export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SUPPORT_OPEN_EVENT, show);
    return () => window.removeEventListener(SUPPORT_OPEN_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    firstInput.current?.focus();
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage({});
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, pagePath: window.location.pathname }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string; notificationDelayed?: boolean };
      if (!response.ok) setMessage({ error: result.error ?? 'Your message could not be sent. Please try again.' });
      else {
        form.reset();
        setMessage({ success: result.notificationDelayed ? 'Your message is saved. Email notification is temporarily delayed.' : 'Thanks. Your message is in my inbox.' });
      }
    } catch {
      setMessage({ error: 'Your message could not be sent. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {open ? (
        <Dialog title="Help & feedback" onClose={() => setOpen(false)} className="support-dialog">
            <div className="support-person">
              <Image src="/yannick-support.png" alt="" width={58} height={58} />
              <div><strong>Talk to Yannick</strong><p>Questions, ideas, and bug reports go directly to me.</p></div>
            </div>
            {message.error ? <div className="error-callout" role="alert">{message.error}</div> : null}
            {message.success ? <div className="callout success" role="status">{message.success}</div> : null}
            <form className="form" onSubmit={(event) => void submit(event)}>
              <label className="field"><span>Message type</span><Select name="kind" defaultValue="support" aria-label="Message type" options={[{ value: 'support', label: 'Question' }, { value: 'feedback', label: 'Product feedback' }, { value: 'bug', label: 'Bug report' }]} /></label>
              <label className="field"><span>Subject</span><Input ref={firstInput} name="subject" minLength={3} maxLength={160} required placeholder="What can I help with?" /></label>
              <label className="field"><span>Message</span><Textarea name="message" minLength={10} maxLength={5000} required placeholder="Tell me what you expected, what happened, and which provider or account is involved." /></label>
              <Input className="support-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="modal-actions"><Button className="button" disabled={busy}>{busy ? 'Sending…' : 'Send message'}</Button><Button className="button secondary" type="button" onClick={() => setOpen(false)}>Cancel</Button></div>
            </form>
        </Dialog>
      ) : null}
    </>
  );
}

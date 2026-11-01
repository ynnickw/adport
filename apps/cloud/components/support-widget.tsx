'use client';

import { Button, Input, Textarea } from '@/components/controls';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Dialog } from './dialog';
import { Select } from './select';

export const SUPPORT_OPEN_EVENT = 'adport:support-open';

export function SupportLauncher({ className }: { className: string }) {
  return <Button type="button" className={className} aria-label="Need help? Message Yannick" onClick={() => window.dispatchEvent(new Event(SUPPORT_OPEN_EVENT))}><Image src="/yannick-support.png" alt="" width={36} height={36} /><span>Need help?</span></Button>;
}

export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const firstInput = useRef<HTMLTextAreaElement>(null);

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
    const subject = String(values.message ?? '').trim().replace(/\s+/g, ' ').slice(0, 160);
    try {
      const response = await fetch('/api/support', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, subject, pagePath: window.location.pathname }),
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
      {!open ? <Button type="button" className="support-fab" aria-label="Need help? Message Yannick" onClick={() => setOpen(true)}><Image src="/yannick-support.png" alt="" width={36} height={36} /><span>Need help?</span></Button> : null}
      {open ? (
        <Dialog title="Message Yannick" onClose={() => setOpen(false)} className="support-dialog">
            <div className="support-person">
              <Image src="/yannick-support.png" alt="" width={58} height={58} />
              <div><strong>Hey, I’m Yannick, the founder.</strong><p>Stuck on something? Send me a message. I read every one.</p></div>
            </div>
            {message.error ? <div className="error-callout" role="alert">{message.error}</div> : null}
            {message.success ? <div className="callout success" role="status">{message.success}</div> : null}
            <form className="form" onSubmit={(event) => void submit(event)}>
              <label className="field"><span>Message type</span><Select name="kind" defaultValue="support" aria-label="Message type" options={[{ value: 'support', label: 'Question' }, { value: 'feedback', label: 'Product feedback' }, { value: 'bug', label: 'Bug report' }]} /></label>
              <label className="field"><span>Your message</span><Textarea data-autofocus ref={firstInput} name="message" minLength={10} maxLength={5000} required placeholder="Hi Yannick, I could use a hand with…" /></label>
              <Input className="support-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="modal-actions"><Button className="button" disabled={busy}>{busy ? 'Sending…' : 'Send to Yannick'}</Button><Button className="button secondary" type="button" onClick={() => setOpen(false)}>Close</Button></div>
              <a className="inline-note" href="mailto:yannick@adport.dev?subject=Adport%20support">Prefer email? yannick@adport.dev ↗</a>
            </form>
        </Dialog>
      ) : null}
    </>
  );
}

'use client';

import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent } from 'react';

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
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
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
        setMessage({ success: result.notificationDelayed ? 'Your message is saved. Email notification is temporarily delayed.' : 'Thanks — your message is in my inbox.' });
      }
    } catch {
      setMessage({ error: 'Your message could not be sent. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="support-fab" type="button" onClick={() => setOpen(true)} aria-label="Contact Adport support">
        <Image src="/yannick-support.png" alt="Yannick from Adport" width={48} height={48} />
        <span>Need help?</span>
      </button>
      {open ? (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="support-modal" role="dialog" aria-modal="true" aria-labelledby="support-title">
            <button className="modal-close" type="button" onClick={() => setOpen(false)} aria-label="Close support dialog">×</button>
            <div className="support-person">
              <Image src="/yannick-support.png" alt="" width={58} height={58} />
              <div><span className="plan-kicker">Direct support</span><h2 id="support-title">Talk to Yannick</h2><p>I read every message. Share a question, product idea, or bug and include enough detail for me to reproduce it.</p></div>
            </div>
            {message.error ? <div className="error-callout" role="alert">{message.error}</div> : null}
            {message.success ? <div className="callout success" role="status">{message.success}</div> : null}
            <form className="form" onSubmit={(event) => void submit(event)}>
              <label className="field"><span>Message type</span><select name="kind" defaultValue="support"><option value="support">Question</option><option value="feedback">Product feedback</option><option value="bug">Bug report</option></select></label>
              <label className="field"><span>Subject</span><input ref={firstInput} name="subject" minLength={3} maxLength={160} required placeholder="What can I help with?" /></label>
              <label className="field"><span>Message</span><textarea name="message" minLength={10} maxLength={5000} required placeholder="Tell me what you expected, what happened, and which provider or account is involved." /></label>
              <input className="support-honeypot" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <div className="modal-actions"><button className="button" disabled={busy}>{busy ? 'Sending…' : 'Send message'}</button><button className="button secondary" type="button" onClick={() => setOpen(false)}>Cancel</button></div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}

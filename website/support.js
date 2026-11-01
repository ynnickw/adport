const supportLauncher = document.querySelector('.site-support-launcher');
const supportDialog = document.querySelector('#site-support-dialog');

if (supportLauncher && supportDialog && typeof supportDialog.showModal === 'function') {
  const form = supportDialog.querySelector('form');
  const send = form.querySelector('button[type="submit"]');
  const error = supportDialog.querySelector('.site-support-error');
  const success = supportDialog.querySelector('.site-support-success');

  supportLauncher.addEventListener('click', event => {
    event.preventDefault();
    supportDialog.showModal();
    supportLauncher.setAttribute('aria-expanded', 'true');
    form.elements.email.focus();
  });
  supportDialog.querySelector('.site-support-close').addEventListener('click', () => supportDialog.close());
  supportDialog.querySelector('.site-support-note a').addEventListener('click', () => supportDialog.close());
  supportDialog.addEventListener('close', () => supportLauncher.setAttribute('aria-expanded', 'false'));
  supportDialog.addEventListener('click', event => {
    if (event.target !== supportDialog) return;
    const bounds = supportDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) supportDialog.close();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity() || send.disabled) return;
    error.hidden = true;
    success.hidden = true;
    send.disabled = true;
    send.textContent = 'Sending…';
    form.setAttribute('aria-busy', 'true');
    const fields = new FormData(form);
    try {
      const response = await fetch('/api/support', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: fields.get('email'), kind: fields.get('kind'), message: fields.get('message'), website: fields.get('website'), pagePath: window.location.pathname }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        error.textContent = typeof result.error === 'string' ? result.error : 'Your message could not be sent. Please try again or use the email link below.';
        error.hidden = false;
        return;
      }
      form.reset();
      success.textContent = 'Thanks. Your message has been sent to Yannick.';
      success.hidden = false;
    } catch {
      error.textContent = 'Your message could not be sent. Check your connection or use the email link below.';
      error.hidden = false;
    } finally {
      send.disabled = false;
      send.textContent = 'Send to Yannick';
      form.removeAttribute('aria-busy');
    }
  });
}

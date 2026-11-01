document.querySelectorAll('.cloud-pricing').forEach(section => {
  const buttons = section.querySelectorAll('[data-billing]');
  buttons.forEach(button => button.addEventListener('click', () => {
    const annual = button.dataset.billing === 'annual';
    const key = annual ? 'annual' : 'monthly';
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    section.querySelectorAll('.pricing-amount strong[data-monthly]').forEach(amount => { amount.textContent = `€${amount.dataset[key]}`; });
    section.querySelectorAll('.pricing-billing-note').forEach(note => { note.textContent = note.dataset[key]; });
    section.querySelectorAll('a[data-plan]').forEach(link => {
      const url = new URL(link.href); url.searchParams.set('billing', annual ? 'annual' : 'monthly'); link.href = url.toString();
    });
  }));
});

const providerTooltips = [];
document.querySelectorAll('[data-provider-tooltip]').forEach(container => {
  const trigger = container.querySelector('.provider-more');
  const tooltip = container.querySelector('[role="tooltip"]');
  let pinned = false;
  let closeTimer;
  const position = () => {
    if (container.classList.contains('provider-stack-card')) {
      const anchor = container.getBoundingClientRect();
      const margin = 16;
      const gap = 12;
      const topEdge = Math.max(margin, (document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 0) + gap);
      const above = anchor.top - topEdge - gap;
      const below = window.innerHeight - anchor.bottom - margin - gap;
      tooltip.style.maxHeight = 'none';
      const placeBelow = above < tooltip.offsetHeight && below > above;
      tooltip.style.maxHeight = `${Math.max(80, placeBelow ? below : above)}px`;
      const bounds = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(margin, Math.min(anchor.left + (anchor.width - bounds.width) / 2, window.innerWidth - bounds.width - margin))}px`;
      tooltip.style.top = `${Math.max(topEdge, placeBelow ? anchor.bottom + gap : anchor.top - gap - bounds.height)}px`;
    }
  };
  const open = () => {
    clearTimeout(closeTimer);
    providerTooltips.forEach(item => { if (item.container !== container) item.close(); });
    tooltip.hidden = false;
    position();
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-describedby', tooltip.id);
  };
  const close = () => {
    clearTimeout(closeTimer);
    pinned = false;
    tooltip.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-describedby');
  };
  providerTooltips.push({ container, tooltip, position, close });
  container.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') open(); });
  container.addEventListener('pointerleave', () => { if (!pinned && !container.contains(document.activeElement)) closeTimer = setTimeout(close, 120); });
  container.addEventListener('focusin', open);
  container.addEventListener('focusout', event => { if (!container.contains(event.relatedTarget)) close(); });
  trigger.addEventListener('click', () => {
    pinned = !pinned;
    if (pinned) open(); else close();
  });
  container.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); event.stopPropagation(); }
  });
});
document.addEventListener('pointerdown', event => {
  providerTooltips.forEach(({ container, close }) => { if (!container.contains(event.target)) close(); });
});
window.addEventListener('resize', () => providerTooltips.forEach(({ tooltip, position }) => { if (!tooltip.hidden) position(); }));
window.addEventListener('scroll', event => {
  providerTooltips.forEach(({ container, tooltip, position, close }) => {
    if (tooltip.hidden || container.contains(event.target)) return;
    const anchor = container.getBoundingClientRect();
    if (container.classList.contains('provider-stack-card') && anchor.bottom > 0 && anchor.top < window.innerHeight) position();
    else close();
  });
}, true);

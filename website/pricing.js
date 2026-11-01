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
  const open = () => {
    tooltip.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-describedby', tooltip.id);
  };
  const close = () => {
    pinned = false;
    tooltip.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-describedby');
  };
  providerTooltips.push({ container, close });
  container.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') open(); });
  container.addEventListener('pointerleave', () => { if (!pinned && !container.contains(document.activeElement)) close(); });
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

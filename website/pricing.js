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

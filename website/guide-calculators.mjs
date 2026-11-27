export function budgetPacing({ budget, spend, days, elapsed }) {
  if (![budget, spend].every(value => Number.isFinite(value) && value >= 0)) {
    return { error: 'Enter a budget and spend of zero or more.' };
  }
  if (!Number.isInteger(days) || days < 28 || days > 31) {
    return { error: 'Enter 28, 29, 30 or 31 days for the reporting month.' };
  }
  if (!Number.isInteger(elapsed) || elapsed < 0 || elapsed > days) {
    return { error: 'Completed days must be a whole number from zero through the number of days in the month.' };
  }
  if (elapsed === 0 && spend > 0) {
    return { error: 'Use zero spend until at least one full reporting day is complete.' };
  }
  const planned = budget * (elapsed / days);
  return {
    planned, variance: spend - planned,
    forecast: elapsed ? (spend / elapsed) * days : null,
    daily: elapsed < days ? Math.max(0, budget - spend) / (days - elapsed) : null,
    note: !elapsed ? 'The forecast starts after the first completed day.'
      : elapsed === days ? 'The month is complete. The forecast equals actual spend.'
      : spend > budget ? 'Spend has exceeded the monthly plan. No planned budget remains.' : '',
  };
}

export function appleAcquisition({ spend, taps, total, installs, first }) {
  if (!Number.isFinite(spend) || spend < 0) return { error: 'Enter spend of zero or more.' };
  const counts = [taps, total, installs, first];
  if (counts.some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
    return { error: 'Enter whole, nonnegative counts. Leave unavailable counts blank.' };
  }
  if ((first !== null && installs !== null && first > installs) ||
      (total !== null && [installs, first].some(value => value !== null && value > total))) {
    return { error: 'Check the install counts. Total installs include tap-through installs, which include tap-through new downloads.' };
  }
  const cost = count => count > 0 ? spend / count : null;
  return {
    cpt: cost(taps), totalCpi: cost(total), tapCpi: cost(installs), firstCost: cost(first),
    note: counts.some(value => !value) ? 'A dash means the count is zero or unavailable.' : '',
  };
}

function activate(panel) {
  const calculate = panel.dataset.guideCalculator === 'pacing' ? budgetPacing : appleAcquisition;
  const currency = panel.querySelector('select');
  const status = panel.querySelector('[data-status]');
  const update = () => {
    const values = {};
    for (const field of panel.querySelectorAll('input')) {
      values[field.name] = field.value === '' && !field.validity.badInput ? null : field.valueAsNumber;
    }
    const result = calculate(values);
    const format = new Intl.NumberFormat('en', { style: 'currency', currency: currency.value });
    for (const output of panel.querySelectorAll('[data-result]')) {
      const amount = result[output.dataset.result];
      const display = Number.isFinite(amount) ? format.format(amount) : '–';
      if (output.textContent !== display) output.textContent = display;
    }
    const message = result.error || result.note || '';
    if (status.textContent !== message) status.textContent = message;
  };
  panel.addEventListener('input', update);
  panel.addEventListener('change', update);
  update();
  panel.hidden = false;
}

if (typeof document !== 'undefined') document.querySelectorAll('[data-guide-calculator]').forEach(activate);

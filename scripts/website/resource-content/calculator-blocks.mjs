const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

function calculator(kind, legend, currency, fields, results) {
  const inputs = fields.map(([name, label, value, step, min = 0, max]) =>
    `<label>${label}<input type="number" name="${name}" value="${value}" min="${min}" step="${step}"${max ? ` max="${max}"` : ''}></label>`).join('');
  const options = currencies.map(code => `<option${code === currency ? ' selected' : ''}>${code}</option>`).join('');
  const outputs = results.map(([name, label]) => `<div><dt>${label}</dt><dd data-result="${name}"></dd></div>`).join('');
  return `<div class="guide-calculator" data-guide-calculator="${kind}" hidden>
    <fieldset><legend>${legend}</legend><div class="calc-fields">${inputs}<label>Account currency<select>${options}</select></label></div></fieldset>
    <div class="calc-readout" aria-live="polite" aria-atomic="true"><dl>${outputs}</dl><p data-status></p></div></div>`;
}

export const pacingCalculator = calculator('pacing', 'Your monthly plan', 'EUR', [
  ['budget', 'Monthly budget', 1520, 'any'], ['spend', 'Spend through completed days', 600, 'any'],
  ['days', 'Days in month', 30, 1, 28, 31], ['elapsed', 'Completed days', 10, 1, 0, 31],
], [
  ['planned', 'Planned spend to date'], ['variance', 'Actual spend minus plan'],
  ['forecast', 'Projected month-end spend'], ['daily', 'Budget per remaining day'],
]);

export const appleCalculator = calculator('apple', 'Your Apple Ads report', 'USD', [
  ['spend', 'Spend', 120, 'any'], ['taps', 'Taps', 60, 1],
  ['total', 'Total installs', 18, 1], ['installs', 'Tap-through installs', 15, 1],
  ['first', 'Tap-through new downloads', 12, 1],
], [
  ['cpt', 'Average cost per tap'], ['totalCpi', 'Cost per total install'],
  ['tapCpi', 'Cost per tap-through install'], ['firstCost', 'Cost per tap-through new download'],
]);

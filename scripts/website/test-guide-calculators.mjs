import assert from 'node:assert/strict';
import test from 'node:test';
import { appleAcquisition, budgetPacing } from '../../website/guide-calculators.mjs';

test('monthly pacing keeps both the forecast and the remaining allowance tied to completed days', () => {
  const sample = { budget: 1520, spend: 600, days: 30, elapsed: 10 };
  const result = budgetPacing(sample);
  assert.equal(result.planned.toFixed(2), '506.67');
  assert.equal(result.variance.toFixed(2), '93.33');
  assert.equal(result.forecast, 1800);
  assert.equal(result.daily, 46);
  const start = budgetPacing({ ...sample, spend: 0, elapsed: 0 });
  assert.equal(start.planned, 0);
  assert.equal(start.forecast, null);
  assert.equal(start.daily, 1520 / 30);
  const end = budgetPacing({ ...sample, elapsed: 30 });
  assert.equal(end.forecast, sample.spend);
  assert.equal(end.daily, null);
  assert.equal(budgetPacing({ ...sample, spend: 1600 }).daily, 0);
  for (const invalid of [{ budget: null }, { spend: -1 }, { elapsed: 31 }, { elapsed: 1.5 }, { elapsed: 0 }, { days: 27 }]) {
    assert.ok(budgetPacing({ ...sample, ...invalid }).error);
  }
});

test('Apple costs keep separate denominators and preserve zero, missing and inconsistent inputs', () => {
  const report = { spend: 120, taps: 60, total: 18, installs: 15, first: 12 };
  const costs = appleAcquisition(report);
  assert.equal(costs.cpt, 2);
  assert.equal(costs.totalCpi.toFixed(2), '6.67');
  assert.equal(costs.tapCpi, 8);
  assert.equal(costs.firstCost, 10);
  const partial = appleAcquisition({ ...report, taps: null, first: 0 });
  assert.equal(partial.cpt, null);
  assert.equal(partial.firstCost, null);
  assert.equal(partial.tapCpi, 8);
  assert.equal(appleAcquisition({ ...report, spend: 0 }).tapCpi, 0);
  for (const invalid of [{ taps: 1.5 }, { first: 16 }, { total: 10, installs: null }, { spend: null }]) {
    assert.ok(appleAcquisition({ ...report, ...invalid }).error);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceBudget, SourceTimeLimitError } from './run-budget.js';

test('local runs without a platform timeout do not get an invented time limit', () => {
    const budget = createSourceBudget(null);
    assert.equal(budget.signal.aborted, false);
    budget.dispose();
});

test('an insufficient remaining runtime stops source work immediately', () => {
    const budget = createSourceBudget(new Date(Date.now() + 1000));
    assert.equal(budget.signal.aborted, true);
    assert.ok(budget.signal.reason instanceof SourceTimeLimitError);
    budget.dispose();
});

test('the source deadline reserves time before the selected platform timeout', async () => {
    const budget = createSourceBudget(new Date(Date.now() + 60), 35);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(budget.signal.aborted, true);
    assert.ok(budget.signal.reason instanceof SourceTimeLimitError);
    budget.dispose();
});

test('finishing source work cancels the deadline timer', async () => {
    const budget = createSourceBudget(new Date(Date.now() + 20), 0);
    budget.dispose();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(budget.signal.aborted, false);
});

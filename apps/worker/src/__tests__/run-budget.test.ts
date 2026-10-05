// P-17: Zeitbudget der Wartungsjobs (audit-rotate, storage-orphan-cleanup).
import { describe, expect, it } from 'vitest';

import { MAINTENANCE_RUN_BUDGET_MS, isWorkerClosing, startRunBudget } from '../run-budget';

describe('startRunBudget', () => {
  it('ist ab Erreichen der Frist erschöpft (Standard: zehn Minuten)', () => {
    let now = 1_000;
    const budget = startRunBudget({ clock: () => now });

    now += MAINTENANCE_RUN_BUDGET_MS - 1;
    expect(budget.exhausted()).toBe(false);
    now += 1;
    expect(budget.exhausted()).toBe(true);
    expect(MAINTENANCE_RUN_BUDGET_MS).toBe(10 * 60_000);
  });

  it('endet sofort, wenn das Stop-Signal anliegt', () => {
    let stop = false;
    const budget = startRunBudget({ budgetMs: 60_000, clock: () => 0, stop: () => stop });

    expect(budget.exhausted()).toBe(false);
    stop = true;
    expect(budget.exhausted()).toBe(true);
  });

  it('erkennt einen schließenden BullMQ-Worker an `closing`', () => {
    expect(isWorkerClosing({})).toBe(false);
    expect(isWorkerClosing({ closing: Promise.resolve() })).toBe(true);
  });
});

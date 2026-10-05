import { describe, expect, it, vi } from 'vitest';

vi.mock('../queues', () => ({ queues: {} }));
vi.mock('../logger', () => ({ log: { info: vi.fn() } }));

import { trimReminderDoneJobHistory, trimRiskAnalyseJobHistory } from '../job-retention';

describe('S-06 risk-analyse-llm job retention', () => {
  it('removes completed jobs after 24 h and failed jobs after 7 days, including legacy ones', async () => {
    const clean = vi
      .fn()
      .mockResolvedValueOnce(['risk-llm-a', 'risk-llm-b'])
      .mockResolvedValueOnce(['risk-llm-c']);

    const result = await trimRiskAnalyseJobHistory({ name: 'risk-analyse-llm', clean } as never);

    expect(clean.mock.calls).toEqual([
      [24 * 60 * 60 * 1_000, 1_000, 'completed'],
      [7 * 24 * 60 * 60 * 1_000, 1_000, 'failed'],
    ]);
    expect(result).toEqual({ completed: 2, failed: 1 });
  });
});

describe('S-06 reminder-done-notify job retention', () => {
  it('removes completed jobs after 24 h and failed jobs after 7 days, including legacy ones', async () => {
    const clean = vi.fn().mockResolvedValueOnce(['reminder-done-a']).mockResolvedValueOnce([]);

    const result = await trimReminderDoneJobHistory({
      name: 'reminder-done-notify',
      clean,
    } as never);

    expect(clean.mock.calls).toEqual([
      [24 * 60 * 60 * 1_000, 1_000, 'completed'],
      [7 * 24 * 60 * 60 * 1_000, 1_000, 'failed'],
    ]);
    expect(result).toEqual({ completed: 1, failed: 0 });
  });
});

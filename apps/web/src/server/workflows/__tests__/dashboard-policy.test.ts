// Fachkatalog: YEAR-END-CAMPAIGN-001, CLIENT-FEEDBACK-001, FORM-SCHEMA-SNAPSHOT-001.
import { describe, expect, it } from 'vitest';
import {
  campaignSubmissionPhase,
  feedbackMonthlyTrend,
  feedbackMonthWindow,
  formAnswerProgress,
} from '../dashboard-policy';
const field = (key: string, type: string, required = false) => ({
  id: key,
  key,
  label: key,
  type,
  required,
  options: null,
  helpText: null,
  defaultValue: null,
  minValue: null,
  maxValue: null,
});
describe('YEAR-END-CAMPAIGN-001 factual progress and separate review states', () => {
  it('uses only frozen input fields and counts zero and optional false without treating an unconfirmed mandatory checkbox as complete', () => {
    const snapshot = {
      version: 1,
      name: 'Frozen',
      description: null,
      introMd: null,
      fields: [
        field('intro', 'INFO_TEXT'),
        field('amount', 'NUMBER', true),
        field('optional', 'CHECKBOX'),
        field('confirm', 'CHECKBOX', true),
        field('missing', 'TEXT', true),
      ],
    };
    expect(
      formAnswerProgress(snapshot, {
        amount: 0,
        optional: false,
        confirm: false,
        oldQuestion: 'ignored',
      }),
    ).toEqual({ filled: 2, total: 4, requiredFilled: 1, requiredTotal: 3, percent: 50 });
    expect(
      formAnswerProgress(
        { ...snapshot, fields: [field('amount', 'NUMBER', true)] },
        { amount: 'invalid' },
      ),
    ).toMatchObject({ filled: 0, percent: 0 });
  });
  it('does not fabricate a progress percentage for legacy or damaged schemas', () => {
    expect(formAnswerProgress(null, {})).toBeNull();
    expect(formAnswerProgress({ version: 1, fields: [{}] }, {})).toBeNull();
  });
  it('separates started, returned, submitted, reviewed and cancelled states', () => {
    const at = new Date();
    expect(campaignSubmissionPhase({ status: 'PENDING', submittedAt: null }, 'OPEN')).toBe(
      'PENDING',
    );
    expect(campaignSubmissionPhase({ status: 'DRAFT', submittedAt: null }, 'OPEN')).toBe(
      'IN_PROGRESS',
    );
    expect(campaignSubmissionPhase({ status: 'DRAFT', submittedAt: at }, 'IN_PROGRESS')).toBe(
      'RETURNED',
    );
    expect(campaignSubmissionPhase({ status: 'SUBMITTED', submittedAt: at }, 'RESPONDED')).toBe(
      'SUBMITTED',
    );
    expect(campaignSubmissionPhase({ status: 'REVIEWED', submittedAt: at }, 'CLOSED')).toBe(
      'REVIEWED',
    );
    expect(campaignSubmissionPhase({ status: 'DRAFT', submittedAt: at }, 'CANCELLED')).toBe(
      'CANCELLED',
    );
  });
});
describe('CLIENT-FEEDBACK-001 twelve Berlin invitation-month cohorts', () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const row = (
    created: string,
    response: string | null = null,
    responded: string | null = null,
  ) => ({
    kind: 'FEEDBACK',
    createdAt: new Date(created),
    response,
    respondedAt: responded ? new Date(responded) : null,
  });
  it('uses twelve calendar months and a Berlin midnight boundary', () => {
    const window = feedbackMonthWindow(now);
    expect(window.keys).toHaveLength(12);
    expect(window.keys[0]).toBe('2025-09');
    expect(window.keys[11]).toBe('2026-08');
    expect(window.start.toISOString()).toBe('2025-08-31T22:00:00.000Z');
  });
  it('retains late replies in their invitation cohort with explicit denominators', () => {
    const trend = feedbackMonthlyTrend(
      [
        row('2026-07-01T10:00:00Z', '5', '2026-08-01T10:00:00Z'),
        row('2026-07-02T10:00:00Z'),
        row('2026-07-31T22:00:00Z', '1', '2026-08-03T10:00:00Z'),
        row('2026-08-04T10:00:00Z', '3', '2026-08-05T10:00:00Z'),
        { ...row('2026-08-04T10:00:00Z', '5', '2026-08-05T10:00:00Z'), kind: 'NOTICE' },
      ],
      now,
    );
    expect(trend.find((m) => m.month === '2026-07')).toEqual({
      month: '2026-07',
      invitations: 2,
      responses: 1,
      average: 5,
      responseRate: 50,
    });
    expect(trend.find((m) => m.month === '2026-08')).toEqual({
      month: '2026-08',
      invitations: 2,
      responses: 2,
      average: 2,
      responseRate: 100,
    });
    expect(trend[0]).toMatchObject({
      invitations: 0,
      responses: 0,
      average: null,
      responseRate: null,
    });
  });
  it('excludes future events and malformed ratings without inflating the average', () => {
    const last = feedbackMonthlyTrend(
      [
        row('2026-08-01T10:00:00Z', '6', '2026-08-02T10:00:00Z'),
        row('2026-08-02T10:00:00Z', '5', '2026-09-01T10:00:00Z'),
        row('2026-09-01T10:00:00Z', '5', '2026-09-02T10:00:00Z'),
      ],
      now,
    ).at(-1);
    expect(last).toMatchObject({ invitations: 2, responses: 0, average: null, responseRate: 0 });
  });
});

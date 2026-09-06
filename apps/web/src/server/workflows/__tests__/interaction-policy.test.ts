import { describe, it, expect } from 'vitest';
// Fachkatalog: CLIENT-FEEDBACK-001
// Fachkatalog: TAX-NOTICE-DECISION-001
// Fachkatalog: YEAR-END-CAMPAIGN-001
import {
  canInviteFeedback,
  validInteractionResponse,
  validWorkflowCalendarDate,
} from '../interaction-policy';
describe('CLIENT-FEEDBACK-001 / TAX-NOTICE-DECISION-001', () => {
  it('YEAR-END-CAMPAIGN-001 rejects normalized impossible calendar dates', () => {
    expect(validWorkflowCalendarDate('2026-02-29')).toBe(false);
    expect(validWorkflowCalendarDate('2028-02-29')).toBe(true);
    expect(validWorkflowCalendarDate('2026-04-31')).toBe(false);
  });
  it('enforces the complete 90-day interval, including its exact boundary', () => {
    const previous = new Date('2026-01-01T10:00:00Z');
    expect(canInviteFeedback(previous, new Date(previous.getTime() + 90 * 86400000 - 1))).toBe(
      false,
    );
    expect(canInviteFeedback(previous, new Date(previous.getTime() + 90 * 86400000))).toBe(true);
    expect(canInviteFeedback(null, previous)).toBe(true);
  });
  it('does not accept a legal-status transition as a client instruction', () => {
    for (const choice of ['EINSPRUCH', 'BESTANDSKRAEFTIG', 'CLOSED', '5'])
      expect(validInteractionResponse('NOTICE', choice)).toBe(false);
    expect(validInteractionResponse('NOTICE', 'APPEAL_REQUESTED')).toBe(true);
    expect(validInteractionResponse('NOTICE', 'NO_OBJECTIONS')).toBe(true);
  });
  it('accepts only integer ratings from one to five', () => {
    for (const choice of ['0', '6', '1.5', 'NaN', 'APPEAL_REQUESTED'])
      expect(validInteractionResponse('FEEDBACK', choice)).toBe(false);
    for (const choice of ['1', '2', '3', '4', '5'])
      expect(validInteractionResponse('FEEDBACK', choice)).toBe(true);
    expect(validInteractionResponse('UNKNOWN', '1')).toBe(false);
  });
});

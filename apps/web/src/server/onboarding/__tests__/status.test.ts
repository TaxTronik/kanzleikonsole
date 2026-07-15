import { describe, expect, it } from 'vitest';
import { computeOnboardingStatus, resumeStep } from '../status';

const empty = {
  allowActive: false,
  onboardingCompletedAt: null,
  contactsActive: 0,
  gwgChecks: 0,
  gwgInvites: 0,
  poas: 0,
  requests: 0,
};

describe('client onboarding status', () => {
  it('keeps an explicitly completed onboarding closed', () => {
    const input = { ...empty, onboardingCompletedAt: '2026-07-15T08:00:00.000Z' };
    expect(computeOnboardingStatus(input)).toBe('COMPLETE');
    expect(resumeStep(input)).toBe('done');
  });

  it('does not mistake activation or an invitation for explicit completion', () => {
    expect(computeOnboardingStatus({ ...empty, allowActive: true })).toBe('IN_PROGRESS');
    expect(computeOnboardingStatus({ ...empty, gwgInvites: 1 })).toBe('IN_PROGRESS');
  });

  it('reports a completely untouched client as open', () => {
    expect(computeOnboardingStatus(empty)).toBe('OPEN');
  });
});

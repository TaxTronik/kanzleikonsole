import { describe, expect, it } from 'vitest';
import { documentRetagDecision } from '../retag-policy';

describe('documentRetagDecision', () => {
  it('verlängert GOBD 8 → 10 durch Re-Store', () => {
    expect(
      documentRetagDecision({
        oldTier: 'GOBD',
        newTier: 'GOBD',
        oldRetentionYears: 8,
        newRetentionYears: 10,
      }),
    ).toBe('RESTORE_WITH_LOCK');
  });

  it('blockiert GOBD 10 → 8, weil der bestehende Lock nicht verkürzbar ist', () => {
    expect(
      documentRetagDecision({
        oldTier: 'GOBD',
        newTier: 'GOBD',
        oldRetentionYears: 10,
        newRetentionYears: 8,
      }),
    ).toBe('BLOCK_RETENTION_SHORTENING');
  });

  it('blockiert Tier-Herabstufung und re-stored Tier-Höherstufung', () => {
    expect(
      documentRetagDecision({
        oldTier: 'GOBD',
        newTier: 'NONE',
        oldRetentionYears: 8,
        newRetentionYears: null,
      }),
    ).toBe('BLOCK_TIER_DOWNGRADE');
    expect(
      documentRetagDecision({
        oldTier: 'NONE',
        newTier: 'GOBD',
        oldRetentionYears: null,
        newRetentionYears: 6,
      }),
    ).toBe('RESTORE_WITH_LOCK');
  });

  it('behandelt GwG nicht als linear schwächere GoBD-Stufe', () => {
    expect(
      documentRetagDecision({
        oldTier: 'GWG',
        newTier: 'GOBD',
        oldRetentionYears: null,
        newRetentionYears: 10,
      }),
    ).toBe('BLOCK_GWG_TIER_CHANGE');
  });
});

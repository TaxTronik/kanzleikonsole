import { describe, expect, it } from 'vitest';
import type { PersistedRecoveryCheckpoint, PersistedVerifyResult } from '@taxtronik/evidence';
import { auditDisplayStatus } from '../status';

const checkpoint = { auditId: '50' } as PersistedRecoveryCheckpoint;
const result = (overrides: Partial<PersistedVerifyResult>) =>
  ({ ok: false, recovered: false, error: null, ...overrides }) as PersistedVerifyResult;

describe('AUDIT-VERIFY-ALERT-001: persisted verification display', () => {
  it('does not turn a new truncation into a historical finding because an old checkpoint exists', () => {
    expect(auditDisplayStatus(result({ policyBreaks: ['Tail-Truncation'] }), checkpoint)).toBe(
      'red',
    );
  });
  it('always exposes a failed run even when recovery was previously marked', () => {
    expect(
      auditDisplayStatus(result({ recovered: true, error: 'database unavailable' }), checkpoint),
    ).toBe('red');
  });
  it('only shows amber with both persisted recovery and a checkpoint', () => {
    expect(auditDisplayStatus(result({ recovered: true }), checkpoint)).toBe('amber');
    expect(auditDisplayStatus(result({ recovered: true }), null)).toBe('red');
    expect(auditDisplayStatus(result({ recovered: undefined }), checkpoint)).toBe('red');
  });
  it('distinguishes unverified and verified states', () => {
    expect(auditDisplayStatus(null, checkpoint)).toBe('none');
    expect(auditDisplayStatus(result({ ok: true }), checkpoint)).toBe('ok');
  });
});

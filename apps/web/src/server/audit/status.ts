import type { PersistedRecoveryCheckpoint, PersistedVerifyResult } from '@taxtronik/evidence';

/** AUDIT-VERIFY-ALERT-001: a historical checkpoint never hides a fresh failure. */
export function auditDisplayStatus(
  result: PersistedVerifyResult | null,
  checkpoint: PersistedRecoveryCheckpoint | null,
): 'none' | 'ok' | 'amber' | 'red' {
  if (!result) return 'none';
  if (result.error) return 'red';
  if (result.ok) return 'ok';
  return checkpoint && result.recovered === true ? 'amber' : 'red';
}

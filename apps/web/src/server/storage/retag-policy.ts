import type { ProtectionTier } from '@taxtronik/storage';

export type RetagDecision =
  | 'METADATA_ONLY'
  | 'RESTORE_WITH_LOCK'
  | 'BLOCK_TIER_DOWNGRADE'
  | 'BLOCK_RETENTION_SHORTENING';

const rank = (tier: ProtectionTier): number => (tier === 'GOBD' ? 2 : tier === 'GWG' ? 1 : 0);

/** Schutzstufen-/Fristentscheidung ohne IO, zentral testbar. */
export function documentRetagDecision(input: {
  oldTier: ProtectionTier;
  newTier: ProtectionTier;
  oldRetentionYears: number | null;
  newRetentionYears: number | null;
}): RetagDecision {
  const oldRank = rank(input.oldTier);
  const newRank = rank(input.newTier);
  if (newRank < oldRank) return 'BLOCK_TIER_DOWNGRADE';
  if (newRank > oldRank) return 'RESTORE_WITH_LOCK';

  if (
    input.oldTier === 'GOBD' &&
    input.oldRetentionYears !== null &&
    input.newRetentionYears !== null
  ) {
    if (input.newRetentionYears < input.oldRetentionYears) {
      return 'BLOCK_RETENTION_SHORTENING';
    }
    if (input.newRetentionYears > input.oldRetentionYears) {
      return 'RESTORE_WITH_LOCK';
    }
  }
  return 'METADATA_ONLY';
}

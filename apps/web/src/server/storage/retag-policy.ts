import type { ProtectionTier } from '@taxtronik/storage';

export type RetagDecision =
  | 'METADATA_ONLY'
  | 'RESTORE_WITH_LOCK'
  | 'BLOCK_TIER_DOWNGRADE'
  | 'BLOCK_GWG_TIER_CHANGE'
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
  // GwG ist keine bloß "schwächere" GoBD-Stufe: § 8 Abs. 4 GwG verlangt die
  // spätere Vernichtung und eine eigene Review-Queue. Ein Retag GWG → GOBD
  // würde den alten GwG-Bytebestand aus genau dieser Queue verlieren. Für eine
  // zusätzliche GoBD-Aufbewahrung muss daher ein separates Dokument entstehen.
  if (input.oldTier === 'GWG' && input.newTier !== 'GWG') {
    return 'BLOCK_GWG_TIER_CHANGE';
  }
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

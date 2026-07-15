export type IdentityInvalidationState = Record<string, { revision: string; generation: number }>;

export function acknowledgeIdentityInvalidation(
  current: IdentityInvalidationState,
  documentSetId: string,
  consumedGeneration: number,
): IdentityInvalidationState {
  if (current[documentSetId]?.generation !== consumedGeneration) return current;
  const next = { ...current };
  delete next[documentSetId];
  return next;
}

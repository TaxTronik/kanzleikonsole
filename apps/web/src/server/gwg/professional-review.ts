export interface ProfessionalGwgReviewState {
  status: string;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  reviewSubmittedAt: Date | null;
  reviewSubmittedBy: string | null;
  validUntil: Date | null;
}

/** Einheitliches fail-closed Gate für UI und serverseitigen Onboarding-Abschluss. */
export function isGwgProfessionallyReviewed(
  check: ProfessionalGwgReviewState | null | undefined,
  now: Date = new Date(),
): boolean {
  return Boolean(
    check?.status === 'VERIFIED' &&
    check.verifiedAt &&
    check.verifiedBy &&
    check.reviewSubmittedAt &&
    check.reviewSubmittedBy &&
    (check.validUntil === null || check.validUntil >= now),
  );
}

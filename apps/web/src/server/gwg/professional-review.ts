import type { Prisma } from '@prisma/client';

/** GWG-RISK-REVIEW-001: fresh database state, never cached session qualification. */
export async function canStaffReviewGwgTx(
  tx: Pick<Prisma.TransactionClient, 'clientResponsibility'>,
  input: { tenantId: string; clientId: string; staffId: string },
): Promise<boolean> {
  return Boolean(
    await tx.clientResponsibility.findFirst({
      where: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        staffId: input.staffId,
        role: 'BERUFSTRAEGER',
        staff: {
          tenantId: input.tenantId,
          active: true,
          isProfessional: true,
          roles: { some: {} },
        },
      },
      select: { id: true },
    }),
  );
}

/**
 * GWG-RISK-REVIEW-001: mutation callers hold the mandate lifecycle lock first.
 * Keep qualification, assignment and a staff role stable until decision commit.
 * Lock even an ineligible account before rechecking: a concurrent revoke wins
 * either before these locks or after the decision, never between check and write.
 */
export async function lockStaffGwgReviewerTx(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'clientResponsibility'>,
  input: { tenantId: string; clientId: string; staffId: string },
): Promise<boolean> {
  const staff = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM staff_user
    WHERE id = ${input.staffId}::uuid AND tenant_id = ${input.tenantId}::uuid
    FOR SHARE
  `;
  if (staff.length === 0) return false;
  const assignments = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM client_responsibility
    WHERE tenant_id = ${input.tenantId}::uuid AND client_id = ${input.clientId}::uuid
      AND staff_id = ${input.staffId}::uuid AND role = 'BERUFSTRAEGER'
    ORDER BY id
    FOR SHARE
  `;
  if (assignments.length === 0) return false;
  const roles = await tx.$queryRaw<Array<{ role: string }>>`
    SELECT r.role FROM staff_role r
    JOIN staff_user s ON s.id = r.staff_user_id
    WHERE s.id = ${input.staffId}::uuid AND s.tenant_id = ${input.tenantId}::uuid
    ORDER BY r.role
    FOR SHARE OF r
  `;
  if (roles.length === 0) return false;
  return canStaffReviewGwgTx(tx, input);
}

/** New assignments must point to active qualified staff with a staff role. */
export async function areProfessionalAssigneesEligibleTx(
  tx: Pick<Prisma.TransactionClient, 'staffUser'>,
  tenantId: string,
  staffIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(staffIds)];
  if (ids.length === 0) return false;
  return (
    (await tx.staffUser.count({
      where: { tenantId, id: { in: ids }, active: true, isProfessional: true, roles: { some: {} } },
    })) === ids.length
  );
}

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

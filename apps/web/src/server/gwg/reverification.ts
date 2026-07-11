import type { TxClient } from '@taxtronik/db';

export interface ReverificationResult {
  invalidatedChecks: number;
  reviewCheckId: string | null;
  clientDeactivated: boolean;
}

/**
 * Entwertet abgeschlossene Prüf-Snapshots, ohne deren Substanzdaten zu
 * überschreiben. Sobald die bisherige Identitätsgrundlage nicht mehr gilt,
 * muss der Mandant fail-closed inaktiv sein. Für Staff-Stammdatenänderungen
 * wird ein bereits offener Review wiederverwendet oder ein neuer angelegt.
 */
export async function requireGwgReverificationTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<ReverificationResult> {
  const invalidated = await tx.gwgCheck.updateMany({
    where: { clientId: input.clientId, status: 'VERIFIED' },
    data: { status: 'EXPIRED' },
  });

  const deactivated = await tx.client.updateMany({
    where: { id: input.clientId, tenantId: input.tenantId, allowActive: true },
    data: { allowActive: false },
  });

  if (invalidated.count === 0) {
    return {
      invalidatedChecks: 0,
      reviewCheckId: null,
      clientDeactivated: deactivated.count > 0,
    };
  }

  const existing = await tx.gwgCheck.findFirst({
    where: { clientId: input.clientId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const review =
    existing ??
    (await tx.gwgCheck.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        status: 'IN_REVIEW',
      },
      select: { id: true },
    }));

  return {
    invalidatedChecks: invalidated.count,
    reviewCheckId: review.id,
    // Der DB-Trigger kann bereits beim Statuswechsel deaktiviert haben; dann
    // trifft das explizite updateMany keine Zeile mehr.
    clientDeactivated: invalidated.count > 0 || deactivated.count > 0,
  };
}

/**
 * Ein öffentlicher Onboarding-Submit erzeugt IMMER einen frischen Snapshot.
 * So kann ein alter/verifizierter Check weder in-place zurückgesetzt noch durch
 * deleteMany seiner Berechtigten/Ausweise zerstört werden. Bestehende
 * VERIFIED-Prüfungen werden terminal markiert und der Mandant fail-closed.
 */
export async function startFreshGwgReviewTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<ReverificationResult & { reviewCheckId: string }> {
  const review = await tx.gwgCheck.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: 'IN_REVIEW',
    },
    select: { id: true },
  });
  const invalidated = await tx.gwgCheck.updateMany({
    where: {
      clientId: input.clientId,
      status: 'VERIFIED',
      id: { not: review.id },
    },
    data: { status: 'EXPIRED' },
  });
  const deactivated = await tx.client.updateMany({
    where: { id: input.clientId, tenantId: input.tenantId, allowActive: true },
    data: { allowActive: false },
  });

  return {
    invalidatedChecks: invalidated.count,
    reviewCheckId: review.id,
    clientDeactivated: invalidated.count > 0 || deactivated.count > 0,
  };
}

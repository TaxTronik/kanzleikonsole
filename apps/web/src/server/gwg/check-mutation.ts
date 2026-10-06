// =============================================================================
// GwG-Prüfung: Bearbeitbarkeit und atomarer Status-Claim vor einer Änderung.
//
// Gemeinsam genutzt vom Prelude der GwG-Services (server/gwg/editable-check.ts,
// Review-Befund K-03) und der Strukturübernahme der Mandatserweiterung
// (server/mandate-expansion).
// =============================================================================

import { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';

// #2 (GwG-Integrität): Nach Abschluss einer Prüfung sind ihre Substanzdaten
// (Risikoantworten, wirtschaftlich Berechtigte, Ausweisdokumente) unveränderlich
// — § 8 GwG verlangt die unveränderte Aufbewahrung der Aufzeichnungen. Nur
// DRAFT/IN_REVIEW sind editierbar; eine Aktualisierung erfolgt über eine neue
// Prüfung (startNewCheckCycleAction) bzw. den durch eine GwG-relevante Stammdaten-
// änderung ausgelösten Reset auf IN_REVIEW (clients/[id]/edit/actions.ts).
const EDITABLE_GWG_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW'];
export type EditableGwgStatus = 'DRAFT' | 'IN_REVIEW';

const PARALLEL_STATUS_CHANGE =
  'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.';

export function assertGwgEditable(status: string): asserts status is EditableGwgStatus {
  if (!EDITABLE_GWG_STATUSES.includes(status)) {
    throw new ActionError(
      'Diese GwG-Prüfung ist bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen) und darf nicht mehr geändert werden (§ 8 GwG). Für eine Aktualisierung bitte eine neue Prüfung anlegen.',
    );
  }
}

export async function claimCheckMutation(
  tx: TxClient,
  input: {
    checkId: string;
    clientId: string;
    expectedStatus: EditableGwgStatus;
    invalidateRisk?: boolean;
  },
): Promise<void> {
  const claim = await tx.gwgCheck.updateMany({
    where: {
      id: input.checkId,
      clientId: input.clientId,
      status: input.expectedStatus,
    },
    data: {
      status: 'DRAFT',
      reviewSubmittedAt: null,
      reviewSubmittedBy: null,
      ...(input.invalidateRisk
        ? {
            riskLevel: null,
            riskScore: null,
            riskAnswers: Prisma.DbNull,
            riskBreakdown: Prisma.DbNull,
          }
        : {}),
    },
  });
  if (claim.count === 0) {
    throw new ActionError(PARALLEL_STATUS_CHANGE);
  }
}

/** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
export async function confirmUnchangedCheck(
  tx: TxClient,
  input: { checkId: string; clientId: string; expectedStatus: EditableGwgStatus },
): Promise<void> {
  const current = await tx.gwgCheck.findFirst({
    where: { id: input.checkId, clientId: input.clientId, status: input.expectedStatus },
    select: { id: true },
  });
  if (!current) {
    throw new ActionError(PARALLEL_STATUS_CHANGE);
  }
}

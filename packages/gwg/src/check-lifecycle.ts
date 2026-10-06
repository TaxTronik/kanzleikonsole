// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001, GWG-IDENTIFICATION-EVIDENCE-001,
// GWG-RISK-REVIEW-001
// =============================================================================
// GwG-Prüfungs-Lebenszyklus mit Tx-Signatur (Review-Befunde K-01/K-03):
// Lifecycle-Lock des Mandanten, Bearbeitbarkeit (§ 8 GwG), atomarer
// Status-Claim und das daraus gebildete Prelude bearbeitender Operationen.
//
// Nur Tx-Client (@taxtronik/db) und Prisma. Autorisierung (Mandantenzugriff),
// Audit-Kette und Speicher bleiben beim Aufrufer: Die Web-Adapter in
// apps/web/src/server/gwg (editable-check.ts, check-mutation.ts) prüfen den
// Zugriff vorab und übersetzen GwgCheckRuleError in UI-taugliche ActionErrors.
// =============================================================================

import { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

export type GwgCheckRuleCode = 'NOT_FOUND' | 'NOT_EDITABLE' | 'STATUS_CHANGED';

/** Fachliche Ablehnung mit UI-tauglicher Meldung; Adapter übersetzen sie in ihr Fehlermodell. */
export class GwgCheckRuleError extends Error {
  readonly code: GwgCheckRuleCode;

  constructor(code: GwgCheckRuleCode, message: string) {
    super(message);
    this.name = 'GwgCheckRuleError';
    this.code = code;
  }
}

export const GWG_CHECK_NOT_FOUND_MESSAGE = 'GwG-Check nicht gefunden.';
export const GWG_CHECK_NOT_EDITABLE_MESSAGE =
  'Diese GwG-Prüfung ist bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen) und darf nicht mehr geändert werden (§ 8 GwG). Für eine Aktualisierung bitte eine neue Prüfung anlegen.';
export const GWG_CHECK_STATUS_CHANGED_MESSAGE =
  'Der Prüfstatus wurde parallel geändert. Ihre Eingabe wurde nicht gespeichert; bitte Seite neu laden.';

// Derselbe transaktionsgebundene Lifecycle-Lock wird aus mehreren
// Defense-in-Depth-Schichten angefordert. Ein WeakMap-Eintrag lebt exakt so
// lange wie der Tx-Client und verhindert den ansonsten redundanten zweiten
// SQL-Roundtrip, ohne den Lock an einem Aufrufpfad wegzulassen. Auch parallele
// Aufrufe auf derselben Tx teilen sich dieselbe Acquisition-Promise.
const lifecycleLockAcquisitions = new WeakMap<object, Map<string, Promise<void>>>();

/**
 * Serialisiert alle statusentscheidenden GwG-Operationen eines Mandanten.
 *
 * Der Lock ist transaktionsgebunden und umfasst bewusst Tenant und Mandant:
 * Zwischen "ist dies der neueste Check?" und einem Statuswechsel darf kein
 * paralleler Pfad einen neuen Snapshot anlegen oder Stammdaten invalidieren.
 * Alle Aufrufer muessen den Lock vor der ersten Client-/GwG-Mutation nehmen.
 */
export async function lockGwgCheckLifecycleTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<void> {
  const lockKey = `gwg-check-lifecycle:${input.tenantId}:${input.clientId}`;
  let acquisitions = lifecycleLockAcquisitions.get(tx as object);
  if (!acquisitions) {
    acquisitions = new Map();
    lifecycleLockAcquisitions.set(tx as object, acquisitions);
  }
  const existing = acquisitions.get(lockKey);
  if (existing) return existing;

  const acquisition = (async () => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  })();
  acquisitions.set(lockKey, acquisition);
  try {
    await acquisition;
  } catch (error) {
    // Ein fehlgeschlagener Versuch darf einen späteren Retry auf derselben Tx
    // nicht fälschlich als gehaltenen Lock behandeln.
    if (acquisitions.get(lockKey) === acquisition) acquisitions.delete(lockKey);
    throw error;
  }
}

// #2 (GwG-Integrität): Nach Abschluss einer Prüfung sind ihre Substanzdaten
// (Risikoantworten, wirtschaftlich Berechtigte, Ausweisdokumente) unveränderlich
// — § 8 GwG verlangt die unveränderte Aufbewahrung der Aufzeichnungen. Nur
// DRAFT/IN_REVIEW sind editierbar; eine Aktualisierung erfolgt über eine neue
// Prüfung bzw. den durch eine GwG-relevante Stammdatenänderung ausgelösten
// Reset (Web: startNewCheckCycleAction, clients/[id]/edit/actions.ts).
const EDITABLE_GWG_STATUSES: readonly string[] = ['DRAFT', 'IN_REVIEW'];
export type EditableGwgStatus = 'DRAFT' | 'IN_REVIEW';

export function assertGwgEditable(status: string): asserts status is EditableGwgStatus {
  if (!EDITABLE_GWG_STATUSES.includes(status)) {
    throw new GwgCheckRuleError('NOT_EDITABLE', GWG_CHECK_NOT_EDITABLE_MESSAGE);
  }
}

/**
 * Status-CAS vor der ersten Fachänderung: setzt eine laufende Freigabe auf
 * DRAFT zurück (optional samt Risikobewertung) und scheitert, wenn sich der
 * Status seit dem Laden geändert hat.
 */
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
    throw new GwgCheckRuleError('STATUS_CHANGED', GWG_CHECK_STATUS_CHANGED_MESSAGE);
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
    throw new GwgCheckRuleError('STATUS_CHANGED', GWG_CHECK_STATUS_CHANGED_MESSAGE);
  }
}

export type GwgCheckSelectWithStatus = Prisma.GwgCheckSelect & { status: true };

export type LoadedGwgCheck<S extends GwgCheckSelectWithStatus> = Prisma.GwgCheckGetPayload<{
  select: S;
}> & { status: string };

export type EditableGwgCheck<S extends GwgCheckSelectWithStatus> = LoadedGwgCheck<S> & {
  status: EditableGwgStatus;
};

export interface EditableGwgCheckMutation {
  /** Status zum Zeitpunkt der Bearbeitbarkeitsprüfung (CAS-Erwartung). */
  readonly expectedStatus: EditableGwgStatus;
  /** Status-CAS vor der ersten Fachänderung; setzt eine laufende Freigabe auf DRAFT zurück. */
  claim(options?: { invalidateRisk?: boolean }): Promise<void>;
  /** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
  confirmUnchanged(): Promise<void>;
}

export interface LockedEditableGwgCheckInput<S extends GwgCheckSelectWithStatus> {
  tenantId: string;
  clientId: string;
  checkId: string;
  select: S;
  /**
   * Fachliche Vorbedingung, deren Meldung vor der Bearbeitbarkeit kommt
   * (z. B. Rechtsform des Mandanten); ihre Fehler gibt das Prelude unverändert weiter.
   */
  beforeEditable?: (check: LoadedGwgCheck<S>) => void;
}

/**
 * Prelude bearbeitender Operationen an einer GwG-Prüfung, nach der
 * Zugriffsprüfung des Aufrufers: Lifecycle-Lock → Prüfung laden (an den
 * Mandanten gebunden) → Vorbedingung → Bearbeitbarkeit → Operation. Den
 * Claim bzw. die No-op-CAS-Prüfung ruft die Operation über `mutation` selbst
 * auf, weil zwischen Bearbeitbarkeit und Claim fachliche Prüfungen liegen.
 */
export async function withLockedEditableGwgCheckTx<S extends GwgCheckSelectWithStatus, R>(
  tx: TxClient,
  input: LockedEditableGwgCheckInput<S>,
  operation: (check: EditableGwgCheck<S>, mutation: EditableGwgCheckMutation) => Promise<R>,
): Promise<R> {
  await lockGwgCheckLifecycleTx(tx, { tenantId: input.tenantId, clientId: input.clientId });
  const check = (await tx.gwgCheck.findFirst({
    where: { id: input.checkId, clientId: input.clientId },
    select: input.select,
  })) as LoadedGwgCheck<S> | null;
  if (!check) throw new GwgCheckRuleError('NOT_FOUND', GWG_CHECK_NOT_FOUND_MESSAGE);
  input.beforeEditable?.(check);
  assertGwgEditable(check.status);
  const scope = {
    checkId: input.checkId,
    clientId: input.clientId,
    expectedStatus: check.status,
  };
  return operation(check as EditableGwgCheck<S>, {
    expectedStatus: check.status,
    claim: (options = {}) => claimCheckMutation(tx, { ...scope, ...options }),
    confirmUnchanged: () => confirmUnchangedCheck(tx, scope),
  });
}

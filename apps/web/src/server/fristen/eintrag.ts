// =============================================================================
// Fristenkontrollbuch — reine Normalisierungs- und Einordnungslogik.
//
// Bewusst OHNE jeden Import (kein DB/IO; Muster: staff-action-policy.ts),
// damit Unit-Tests die Status-Wahrheitstabellen je Quelle ziehen können.
//
// Designentscheidung: Das Kontrollbuch ist eine KONTROLLSICHT über die fünf
// fristenführenden Quellen — es hält KEINEN eigenen Zustand. Erledigung
// passiert im Quellmodul (dort auditiert); hier wird sie nur abgelesen.
// Dadurch kann das Buch nie vom echten Zustand abweichen.
// =============================================================================

export type FristQuelle =
  | 'STEUERTERMIN'
  | 'EINSPRUCHSFRIST'
  | 'KLAGEFRIST'
  | 'ANFORDERUNG'
  | 'WIEDERVORLAGE';

export const QUELLE_LABELS: Record<FristQuelle, string> = {
  STEUERTERMIN: 'Steuertermin',
  EINSPRUCHSFRIST: 'Einspruchsfrist',
  KLAGEFRIST: 'Klagefrist',
  ANFORDERUNG: 'Anforderung',
  WIEDERVORLAGE: 'Wiedervorlage',
};

/**
 * Unveränderbare fachliche Einordnung für Tagesabschluss-Snapshots. Sie
 * verhindert insbesondere, dass ein interner Risikotermin oder ein noch zu
 * prüfender Rechenvorschlag später allein durch die Quellenbezeichnung als
 * feststehende Rechtsfrist gelesen wird.
 */
export type FristKontrollart =
  | 'CALCULATED_CONTROL_PROPOSAL'
  | 'REVIEW_PENDING_CONTROL_PROPOSAL'
  | 'INTERNAL_RISK'
  | 'OPERATIONAL_DUE_DATE';

export interface FristEintrag {
  quelle: FristQuelle;
  kontrollart: FristKontrollart;
  /**
   * Wahrheitsgemäße Anzeigeart, wenn ein Eintrag technisch zu einer Quelle
   * gehört, aber keine Frist dieser Art behaupten darf (z. B. interner
   * Bescheid-Prüftermin ohne berechnete Einspruchsfrist).
   */
  artLabel?: string;
  id: string;
  titel: string;
  clientId: string;
  clientName: string;
  faelligAm: Date;
  erledigt: boolean;
  /** Aus dem Quellvorgang abgeleiteter Kontrollzustand; kein frei editierbarer Parallelstatus. */
  kontrollzustand:
    | 'OPEN'
    | 'CLOSED_FULFILLED'
    | 'CLOSED_DISPOSITION'
    | 'CLOSED_NOT_APPLICABLE'
    | 'SUPERSEDED';
  /** Warum ein Status trotz scheinbarem Abschluss weiter offen bleibt. */
  kontrollhinweis: string | null;
  erledigtAm: Date | null;
  /** Name der erledigenden Person (sofern die Quelle ihn führt). */
  erledigtVon: string | null;
  /** Verantwortliche Person (Hauptbearbeiter des Mandanten bzw. Zuweisung). */
  verantwortlich: string | null;
  verantwortlichId: string | null;
  href: string;
}

// --- Status-Wahrheitstabellen je Quelle -------------------------------------

/**
 * Steuertermin: Ein Status allein ist kein Abschlussnachweis. `SKIPPED` bleibt
 * mangels strukturiertem Grund/Freigabe offen; `DONE` braucht Zeit und Person.
 */
export function taxDeadlineErledigt(
  status: string,
  completedAt: Date | null = null,
  completedBy: string | null = null,
): boolean {
  return status === 'DONE' && completedAt !== null && completedBy !== null;
}

/**
 * Einspruchsfrist: Ein späterer Verfahrensstatus genügt nicht. Die konkrete
 * Frist ist erst durch dokumentierte Einlegung (Zeit und handelnde Person)
 * erfüllt oder durch eine dokumentierte Bestandskraft-Entscheidung disponiert.
 */
export function taxNoticeFristErledigt(
  status: string,
  evidence: {
    appealDeadline?: Date | null;
    appealFiledAt?: Date | null;
    appealFiledBy?: string | null;
    legalFinalAt?: Date | null;
    legalFinalBy?: string | null;
    legalFinalReason?: string | null;
  } = {},
): boolean {
  const filingRecorded = filingWithinDeadline(
    evidence.appealFiledAt,
    evidence.appealFiledBy,
    evidence.appealDeadline,
  );
  const dispositionRecorded =
    status === 'BESTANDSKRAEFTIG' &&
    Boolean(evidence.legalFinalAt && evidence.legalFinalBy && evidence.legalFinalReason?.trim());
  return filingRecorded || dispositionRecorded;
}

/**
 * Klagefrist (§ 47 FGO): läuft nach der Einspruchsentscheidung
 * (ZURUECKGEWIESEN oder TEILEINSPRUCHSENTSCHEIDUNG). TEILABHILFE allein
 * löst keine Klagefrist aus. Geschlossen wird nur mit Einreichungs- oder
 * dokumentiertem Dispositionsnachweis.
 */
export function taxNoticeKlageFristErledigt(
  status: string,
  evidence: {
    klageDeadline?: Date | null;
    klageFiledAt?: Date | null;
    klageFiledBy?: string | null;
    legalFinalAt?: Date | null;
    legalFinalBy?: string | null;
    legalFinalReason?: string | null;
  } = {},
): boolean {
  const filingRecorded = filingWithinDeadline(
    evidence.klageFiledAt,
    evidence.klageFiledBy,
    evidence.klageDeadline,
  );
  const dispositionRecorded =
    status === 'BESTANDSKRAEFTIG' &&
    Boolean(evidence.legalFinalAt && evidence.legalFinalBy && evidence.legalFinalReason?.trim());
  return filingRecorded || dispositionRecorded;
}

/**
 * Ein tatsächlicher Einlegungstag bleibt auch nach Fristablauf ein wichtiger
 * Verfahrensnachweis, erfüllt die kontrollierte Frist aber nicht rückwirkend.
 * Ohne bekannte Frist oder handelnde Person wird ebenfalls fail-closed nicht
 * als fristgerecht geschlossen.
 */
export function filingWithinDeadline(
  filedAt: Date | null | undefined,
  filedBy: string | null | undefined,
  deadline: Date | null | undefined,
): boolean {
  if (!filedAt || !filedBy || !deadline) return false;
  const filingDay = Date.UTC(filedAt.getUTCFullYear(), filedAt.getUTCMonth(), filedAt.getUTCDate());
  const deadlineDay = Date.UTC(
    deadline.getUTCFullYear(),
    deadline.getUTCMonth(),
    deadline.getUTCDate(),
  );
  return filingDay <= deadlineDay;
}

/**
 * Anforderung: `RESPONDED` wartet auf Kanzleiprüfung. `CLOSED` benötigt den
 * gespeicherten Abschluss; `CANCELLED` bleibt ohne strukturierten Grund offen.
 */
export function requestErledigt(
  status: string,
  closedAt: Date | null = null,
  closedBy: string | null = null,
): boolean {
  return status === 'CLOSED' && closedAt !== null && closedBy !== null;
}

// --- Einordnung --------------------------------------------------------------

export type FristBucket = 'UEBERFAELLIG' | 'HEUTE' | 'DIESE_WOCHE' | 'SPAETER';

/** Tagesgenaue Einordnung relativ zu `heute` (UTC-Tagesgrenzen). */
export function bucketFor(faelligAm: Date, heute: Date): FristBucket {
  const tag = Date.UTC(faelligAm.getUTCFullYear(), faelligAm.getUTCMonth(), faelligAm.getUTCDate());
  const heuteTag = Date.UTC(heute.getUTCFullYear(), heute.getUTCMonth(), heute.getUTCDate());
  if (tag < heuteTag) return 'UEBERFAELLIG';
  if (tag === heuteTag) return 'HEUTE';
  if (tag <= heuteTag + 6 * 86400000) return 'DIESE_WOCHE';
  return 'SPAETER';
}

export const BUCKET_LABELS: Record<FristBucket, string> = {
  UEBERFAELLIG: 'Überfällig',
  HEUTE: 'Heute fällig',
  DIESE_WOCHE: 'Diese Woche',
  SPAETER: 'Später',
};

/** Sortierung: offene zuerst (älteste Fälligkeit vorn), erledigte hinten (neueste vorn). */
export function sortEintraege(eintraege: FristEintrag[]): FristEintrag[] {
  return [...eintraege].sort((a, b) => {
    if (a.erledigt !== b.erledigt) return a.erledigt ? 1 : -1;
    return a.erledigt
      ? b.faelligAm.getTime() - a.faelligAm.getTime()
      : a.faelligAm.getTime() - b.faelligAm.getTime();
  });
}

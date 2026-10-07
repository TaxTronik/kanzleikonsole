// =============================================================================
// Fristenkontrollbuch — reine Normalisierungs- und Einordnungslogik.
//
// Bewusst OHNE DB/IO (Muster: staff-action-policy.ts), damit Unit-Tests die
// Status-Wahrheitstabellen je Quelle ziehen können. Einziger Import ist die
// reine Berliner-Kalendertag-Hilfe aus @taxtronik/tax.
//
// Designentscheidung: Das Kontrollbuch ist eine KONTROLLSICHT über die fünf
// fristenführenden Quellen — es hält KEINEN eigenen Zustand. Erledigung
// passiert im Quellmodul (dort auditiert); hier wird sie nur abgelesen.
// Dadurch kann das Buch nie vom echten Zustand abweichen.
// =============================================================================

import { berlinCalendarDate } from '@taxtronik/tax';

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
 * Zeichen, die String.prototype.trim() entfernt (ECMAScript WhiteSpace und
 * LineTerminator). Dieselbe Liste nutzt app.legal_final_reason_sufficient in der
 * Datenbank (Migration 20261006170000_tax_notice_legal_final_reason_whitespace).
 */
export const RAND_LEERRAUM_CODEPOINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const RAND_LEERRAUM = new Set(RAND_LEERRAUM_CODEPOINTS);

/** Mindestlänge der Bestandskraft-Begründung (TAX-CONTROL-STATUS-001). */
export const BEGRUENDUNG_MIN_ZEICHEN = 10;

/**
 * Bestandskraft-Begründung „von mindestens zehn Zeichen“: ohne Leerraum am Rand,
 * gezählt in Zeichen (Codepunkten) wie `length()` in PostgreSQL. Dieselbe Regel
 * prüft die Datenbank; ein Text nur aus Tabs oder Zeilenumbrüchen ist keine
 * Begründung, und die Frist bleibt offen.
 */
export function begruendungTragfaehig(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const zeichen = Array.from(reason, (c) => c.codePointAt(0)!);
  let start = 0;
  let ende = zeichen.length;
  while (start < ende && RAND_LEERRAUM.has(zeichen[start]!)) start++;
  while (ende > start && RAND_LEERRAUM.has(zeichen[ende - 1]!)) ende--;
  return ende - start >= BEGRUENDUNG_MIN_ZEICHEN;
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
    Boolean(evidence.legalFinalAt && evidence.legalFinalBy) &&
    begruendungTragfaehig(evidence.legalFinalReason);
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
    Boolean(evidence.legalFinalAt && evidence.legalFinalBy) &&
    begruendungTragfaehig(evidence.legalFinalReason);
  return filingRecorded || dispositionRecorded;
}

/**
 * Ein tatsächlicher Einlegungstag bleibt auch nach Fristablauf ein wichtiger
 * Verfahrensnachweis, erfüllt die kontrollierte Frist aber nicht rückwirkend.
 * Ohne bekannte Frist oder handelnde Person wird ebenfalls fail-closed nicht
 * als fristgerecht geschlossen.
 *
 * Einlegungstag ist der Berliner Kalendertag des gespeicherten Zeitpunkts: Die
 * Frist endet mit Ablauf ihres letzten Tages nach gesetzlicher Zeit (§ 108 Abs. 1
 * AO i. V. m. § 188 BGB). Das Formular speichert den gewählten Tag als
 * UTC-Mitternacht, also denselben Berliner Tag; ein Altbestand ab 23:00 Uhr UTC
 * (Winterzeit) bzw. 22:00 Uhr UTC (Sommerzeit) gehört zum folgenden Berliner
 * Tag. Dieselbe Ableitung nutzen die
 * Vorabfragen (quellen/bescheid.ts), die Bescheid-Übergänge und die Datenbank
 * (Migration 20261007110000_tax_notice_berlin_filing_day).
 */
export function filingWithinDeadline(
  filedAt: Date | null | undefined,
  filedBy: string | null | undefined,
  deadline: Date | null | undefined,
): boolean {
  if (!filedAt || !filedBy || !deadline) return false;
  const filingDay = berlinCalendarDate(filedAt).getTime();
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

// =============================================================================
// Fristenkontrollbuch — reine Normalisierungs- und Einordnungslogik.
//
// Bewusst OHNE jeden Import (kein DB/IO; Muster: staff-action-policy.ts),
// damit Unit-Tests die Status-Wahrheitstabellen je Quelle ziehen können.
//
// Designentscheidung: Das Kontrollbuch ist eine KONTROLLSICHT über die vier
// fristenführenden Quellen — es hält KEINEN eigenen Zustand. Erledigung
// passiert im Quellmodul (dort auditiert); hier wird sie nur abgelesen.
// Dadurch kann das Buch nie vom echten Zustand abweichen.
// =============================================================================

export type FristQuelle = 'STEUERTERMIN' | 'EINSPRUCHSFRIST' | 'ANFORDERUNG' | 'WIEDERVORLAGE';

export const QUELLE_LABELS: Record<FristQuelle, string> = {
  STEUERTERMIN: 'Steuertermin',
  EINSPRUCHSFRIST: 'Einspruchsfrist',
  ANFORDERUNG: 'Anforderung',
  WIEDERVORLAGE: 'Wiedervorlage',
};

export interface FristEintrag {
  quelle: FristQuelle;
  id: string;
  titel: string;
  clientId: string;
  clientName: string;
  faelligAm: Date;
  erledigt: boolean;
  erledigtAm: Date | null;
  /** Name der erledigenden Person (sofern die Quelle ihn führt). */
  erledigtVon: string | null;
  /** Verantwortliche Person (Hauptbearbeiter des Mandanten bzw. Zuweisung). */
  verantwortlich: string | null;
  verantwortlichId: string | null;
  href: string;
}

// --- Status-Wahrheitstabellen je Quelle -------------------------------------

/** Steuertermin: DONE/SKIPPED = erledigt; alles andere (inkl. OVERDUE) offen. */
export function taxDeadlineErledigt(status: string): boolean {
  return status === 'DONE' || status === 'SKIPPED';
}

/**
 * Einspruchsfrist: behandelt, sobald über den Einspruch ENTSCHIEDEN wurde —
 * EINSPRUCH (eingelegt, Frist gewahrt) oder RECHTSKRAEFTIG (bewusst
 * akzeptiert) bzw. die Folgezustände. GEPRUEFT heißt nur „inhaltlich
 * gesichtet", die Einspruchsentscheidung steht noch aus → Frist bleibt offen.
 */
export function taxNoticeFristErledigt(status: string): boolean {
  return (
    status === 'EINSPRUCH' ||
    status === 'ABGEHOLFEN' ||
    status === 'ZURUECKGEWIESEN' ||
    status === 'RECHTSKRAEFTIG'
  );
}

/** Anforderung: erst CLOSED/CANCELLED ist erledigt (RESPONDED = Mandant hat geliefert, Prüfung offen). */
export function requestErledigt(status: string): boolean {
  return status === 'CLOSED' || status === 'CANCELLED';
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

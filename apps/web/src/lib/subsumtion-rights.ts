// =============================================================================
// Rechtestufen im Subsumtions-Space — reines Daten-/Entscheidungsmodul.
//
// Bewusst ohne Server-Importe (kein rbac, kein Prisma), damit die Regel im
// Unit-Test und im Client-Bundle nutzbar bleibt — dasselbe Muster wie
// `lib/staff-permissions.ts`. Die Fakten beschafft `server/risk/rights.ts`.
//
// Drei Stufen:
//   voll        Admin/Partner oder dem Mandanten zugeordnete:r Berufstraeger/
//               Hauptbearbeiter:in — dieselbe Regel wie die Nav-Pill.
//   bearbeiter  hat in DIESER Analyse mindestens eine Markierung zugewiesen
//               bekommen; darf ausschliesslich dort recherchieren.
//   leser       darf den Mandanten sehen, sonst nichts.
// =============================================================================

/** Was eine Aktion verlangt. */
export type SubsumtionActionKind =
  /** Reine Abfrage — jeder mit Mandantenzugriff. */
  | 'lesen'
  /** Veraendert Analyse, Markierungen, Kataloge oder Vorlagen. */
  | 'schreiben'
  /** Bearbeitung EINER Markierung durch die zugewiesene Person. */
  | 'recherche';

export interface SubsumtionRights {
  /** Stufe „voll". */
  canWrite: boolean;
  /** Markierungen DIESER Analyse, die dem Aufrufer zugewiesen sind. */
  assignedMarkingIds: string[];
}

/**
 * Darf der Aufrufer die Aktion ausfuehren?
 *
 * `recherche` ohne `markingId` ist immer falsch: Eine Recherche ohne Bezug zu
 * einer zugewiesenen Markierung waere der ganze Fall — und damit wieder die
 * Vollmacht, die wir gerade einschraenken.
 */
export function decideSubsumtionAction(
  rights: SubsumtionRights,
  kind: SubsumtionActionKind,
  markingId?: string | null,
): boolean {
  if (kind === 'lesen') return true;
  if (rights.canWrite) return true;
  if (kind === 'schreiben') return false;
  if (!markingId) return false;
  return rights.assignedMarkingIds.includes(markingId);
}

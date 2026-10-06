// =============================================================================
// Fristenkontrollbuch — Vertrag der Quellenadapter.
//
// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Jede fristenführende Quelle beschreibt ihr Prisma-Fenster (`where`), ihre
// Abfragen (`query`/`count`) und die Abbildung einer Quellzeile auf einen
// Kontrollbuch-Eintrag (`toEintrag`). Der Orchestrator in kontrollbuch.ts kennt
// keine Quelle im Einzelnen; eine neue Quelle ist ein neuer Adapter in
// quellen/index.ts.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { FristEintrag } from '../eintrag';

/** Modulschalter; Anforderungen sind Kernfunktion und immer aktiv. */
export interface KontrollbuchQuellen {
  taxNotices: boolean;
  reminders: boolean;
}

export interface KontrollbuchKontext {
  /** Fachlicher Stichtag als UTC-Mitternacht des Berlin-Kalendertags. */
  heute: Date;
  /** Obergrenze aller Fenster: heute + tage. */
  horizont: Date;
  /** Untergrenze des Rückschau-Zweigs nachgewiesen erledigter Fristen: heute − tage. */
  rueckschau: Date;
  nurOffene: boolean;
  nurStaffId: string | null;
  /** Sichtbarkeitsregel aus `accessibleClientsWhereFor`; `{}` heißt keine Einschränkung. */
  clientAccess: Prisma.ClientWhereInput;
  /** Zuständigkeitsfilter „Meine“ (Hauptbearbeiter), sonst undefined. */
  responsibleClient: Prisma.ClientWhereInput | undefined;
  /**
   * Sichtbarkeitsregel und optionale Zuständigkeit in EINEM `client`-Filter: ein
   * zweiter `client`-Schlüssel im Objekt-Spread würde die Regel überschreiben.
   */
  visibleClient: { client?: Prisma.ClientWhereInput };
}

/**
 * Prisma-Filter einer Quelle. Offener und erledigter Zweig sind disjunkt.
 *
 * - `fenster`: Gesamtabfrage des vollständigen Loaders. Offen ohne untere
 *   Grenze bis zum Horizont, ohne `nurOffene` zusätzlich nachgewiesen Erledigte
 *   im Rückschau-Fenster.
 * - `offen`: Teil des offenen Zweigs, dessen Zeilen nach `toEintrag` immer offen
 *   sind. Nur er wird seitenweise geladen und per `count` gezählt.
 * - `offenVorbehalt`: Rest des offenen Zweigs, dessen Abschluss erst `toEintrag`
 *   entscheidet (nach Fristende dokumentierte Einlegungen). Kleine Menge, wird
 *   vollständig geladen; `null`, wenn es ihn nicht gibt.
 * - `erledigt`: Rückschau-Zweig, nur ohne `nurOffene` (sonst `null`); wird
 *   vollständig geladen, weil auch er durch `toEintrag` offen bleiben kann.
 */
export interface QuellFilter<Where> {
  fenster: Where;
  offen: Where;
  offenVorbehalt: Where | null;
  erledigt: Where | null;
}

/** Zusätzliche Grenze auf die Fälligkeitsspalte einer Quelle. */
export type FaelligGrenze = { lt: Date } | { lte: Date };

/** Personenbezug eines Eintrags, aufgelöst nach dem Laden aller Quellzeilen. */
export interface Personen {
  name(staffId: string | null): string | null;
  /** Hauptbearbeiter des Mandanten (bei „Meine“ nur die gefilterte Person). */
  hauptbearbeiter(clientId: string): string | null;
}

/** Mandant und Personen, deren Namen ein Eintrag braucht. */
export interface QuellBezug {
  clientId: string | null;
  staffIds: ReadonlyArray<string | null>;
}

/**
 * Adapter einer fristenführenden Quelle. Methoden-Syntax (bivariante
 * Parameter), damit Adapter verschiedener Zeilentypen in einer Liste stehen;
 * der Orchestrator reicht nur Werte desselben Adapters weiter.
 */
export interface KontrollbuchQuelle<Row, Where, Vorab = undefined> {
  /** Bisherige Einfügereihenfolge; ordnet Einträge gleicher Fälligkeit. */
  readonly rang: number;
  aktiv(quellen: KontrollbuchQuellen): boolean;
  /** Optionale Vorabfrage im selben Transaktions-Snapshot wie die Hauptabfragen. */
  vorab?(tx: TxClient, k: KontrollbuchKontext): Promise<Vorab>;
  where(k: KontrollbuchKontext, vorab: Vorab): QuellFilter<Where>;
  /** Mit `seite`: nach Fälligkeit und ID aufsteigend, höchstens `take` Zeilen. */
  query(tx: TxClient, where: Where, seite?: { take: number }): Promise<Row[]>;
  count(tx: TxClient, where: Where, faellig?: FaelligGrenze): Promise<number>;
  bezug(row: Row): QuellBezug;
  /** `null` überspringt eine Zeile ohne Fälligkeit. */
  toEintrag(row: Row, personen: Personen): FristEintrag | null;
}

/** Verantwortliche Person: Hauptbearbeiter des Mandanten. */
export function verantwortung(
  personen: Personen,
  clientId: string,
): { id: string | null; name: string | null } {
  const id = personen.hauptbearbeiter(clientId);
  return { id, name: personen.name(id) };
}

/** Gemeinsame Sortierung der Seitenabfragen: Fälligkeit, dann ID. */
export function seitenAbfrage<OrderBy>(
  seite: { take: number } | undefined,
  orderBy: OrderBy[],
): { orderBy?: OrderBy[]; take?: number } {
  return seite ? { orderBy, take: seite.take } : {};
}

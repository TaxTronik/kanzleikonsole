// =============================================================================
// Fristenkontrollbuch — Loader.
//
// Aggregiert die fünf fristenführenden Quellen (Steuertermine, Bescheidprüf-
// fälle/Einspruchsfristen, Klagefristen, Anforderungen, Wiedervorlagen) zu
// einer Kontrollsicht. Eigener Zustand entsteht hier NICHT (siehe eintrag.ts)
// — Erledigung wird aus den Quellmodulen abgelesen, wo sie auditiert geführt
// wird. Jede Quelle ist ein Adapter in quellen/ (Fenster, Abfrage, Abbildung);
// dieser Orchestrator lädt, löst Personen auf und ordnet.
//
// Fensterlogik: OFFENE Fristen erscheinen bis zum Horizont (heute + tage)
// OHNE untere Grenze — eine überfällige Frist verschwindet nie durch
// Zeitablauf. ERLEDIGTE erscheinen nur im Fenster [heute − tage, Horizont]
// (Kontrollsicht der jüngeren Vergangenheit). Der CSV-Export ist ein
// auditierter Kontrollauszug, aber kein Nachweis der fristwahrenden Handlung.
//
// Zugriffsmodell: RESTRICTED-/vertrauliche Mandanten werden über die
// Sichtbarkeitsregel (Relationsfilter) ausgeblendet (identisch zu
// Kalender/Exporten).
//
// `loadKontrollbuch` liefert die vollständige Sicht (CSV-Export,
// Tagesabschluss). `loadKontrollbuchSeite` blättert für die Seite getrennt in
// den offenen und den erledigten Einträgen; alle Seiten zusammen ergeben
// dieselben Einträge in derselben Reihenfolge.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { clientAccessFilter } from '@/server/auth/client-access-filter';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import { type FristEintrag, sortEintraege } from './eintrag';
import { type AnyKontrollbuchQuelle, KONTROLLBUCH_QUELLEN } from './quellen';
import type { KontrollbuchKontext, Personen, QuellFilter } from './quellen/typen';

export interface KontrollbuchOptions {
  /** Horizont in Tagen (Zukunft) und Rückschau für Erledigte. */
  tage: number;
  /** Erledigte bereits in den Quellabfragen ausschließen. */
  nurOffene?: boolean;
  /** Nur Einträge, für die diese Person verantwortlich ist. */
  nurStaffId?: string | null;
  /** Modulquellen; Kern-Anforderungen bleiben unabhängig davon aktiv. */
  sources?: {
    taxNotices: boolean;
    reminders: boolean;
  };
  /** Festgehaltener fachlicher Stichtag, z. B. aus der DB-Uhr des Tagesabschlusses. */
  referenceDate?: Date;
}

const TAG_MS = 86_400_000;

interface Quelllauf {
  quelle: AnyKontrollbuchQuelle;
  filter: QuellFilter<unknown>;
}

interface Kandidat {
  quelle: AnyKontrollbuchQuelle;
  row: unknown;
}

interface Geordnet {
  kandidat: Kandidat;
  rang: number;
  eintrag: FristEintrag;
}

async function vorbereiten(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchOptions,
): Promise<{ kontext: KontrollbuchKontext; laeufe: Quelllauf[] }> {
  const heute = opts.referenceDate ?? berlinTodayUtcMidnight();
  const quellen = { taxNotices: true, reminders: true, ...opts.sources };
  const clientAccess = await accessibleClientsWhereFor(tx, session);
  const responsibleClient: Prisma.ClientWhereInput | undefined = opts.nurStaffId
    ? { responsibilities: { some: { role: 'HAUPTBEARBEITER', staffId: opts.nurStaffId } } }
    : undefined;
  const kontext: KontrollbuchKontext = {
    heute,
    horizont: new Date(heute.getTime() + opts.tage * TAG_MS),
    rueckschau: new Date(heute.getTime() - opts.tage * TAG_MS),
    nurOffene: Boolean(opts.nurOffene),
    nurStaffId: opts.nurStaffId ?? null,
    clientAccess,
    responsibleClient,
    visibleClient: clientAccessFilter(clientAccess, responsibleClient),
  };
  const aktiv = KONTROLLBUCH_QUELLEN.filter((quelle) => quelle.aktiv(quellen));
  // Vorabfragen (z. B. verspätete Einlegungen) laufen vor allen Hauptabfragen
  // derselben REPEATABLE-READ-Transaktion.
  const vorab = await Promise.all(aktiv.map((quelle) => quelle.vorab?.(tx, kontext)));
  return {
    kontext,
    laeufe: aktiv.map((quelle, i) => ({ quelle, filter: quelle.where(kontext, vorab[i]) })),
  };
}

/**
 * Verantwortliche: Hauptbearbeiter je Mandant (eine Query) — Wiedervorlagen mit
 * eigener Zuweisung überschreiben das. Namen in einer zweiten Query.
 *
 * Hat ein Mandant mehrere Hauptbearbeiter, führt die erste Zuordnung (wie bei
 * Wiedervorlagen die erste Zuweisung). Früher gewann die zuletzt gelieferte
 * Zeile; deren Reihenfolge hing vom Abfrageplan ab, sodass Seite, CSV und
 * Tagesabschluss verschiedene Personen nennen konnten.
 */
async function ladePersonen(
  tx: TxClient,
  kandidaten: readonly Kandidat[],
  nurStaffId: string | null,
): Promise<Personen> {
  const bezuege = kandidaten.map(({ quelle, row }) => quelle.bezug(row));
  const clientIds = new Set<string>();
  for (const bezug of bezuege) if (bezug.clientId) clientIds.add(bezug.clientId);
  const responsibilities = clientIds.size
    ? await tx.clientResponsibility.findMany({
        where: {
          clientId: { in: [...clientIds] },
          role: 'HAUPTBEARBEITER',
          ...(nurStaffId ? { staffId: nurStaffId } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { staffId: 'asc' }],
        select: { clientId: true, staffId: true },
      })
    : [];
  const hauptbearbeiter = new Map<string, string>();
  for (const r of responsibilities) {
    if (!hauptbearbeiter.has(r.clientId)) hauptbearbeiter.set(r.clientId, r.staffId);
  }

  const staffIds = new Set<string>(hauptbearbeiter.values());
  for (const bezug of bezuege) for (const id of bezug.staffIds) if (id) staffIds.add(id);
  const staff = staffIds.size
    ? await tx.staffUser.findMany({
        where: { id: { in: [...staffIds] } },
        select: { id: true, fullName: true },
      })
    : [];
  const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
  return {
    name: (staffId) => (staffId ? (staffName.get(staffId) ?? null) : null),
    hauptbearbeiter: (clientId) => hauptbearbeiter.get(clientId) ?? null,
  };
}

function abbilden(kandidaten: readonly Kandidat[], personen: Personen): Geordnet[] {
  return kandidaten.flatMap((kandidat) => {
    const eintrag = kandidat.quelle.toEintrag(kandidat.row, personen);
    return eintrag ? [{ kandidat, rang: kandidat.quelle.rang, eintrag }] : [];
  });
}

function vergleicheId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Ordnung von `sortEintraege` (offene nach Fälligkeit aufsteigend, erledigte
 * absteigend). Gleichstände ordnet die bisherige Quellreihenfolge (`rang`), dann
 * die ID — stabil, statt von der Zeilenfolge der Datenbank abzuhängen.
 */
function ordnen(liste: readonly Geordnet[]): Geordnet[] {
  const vorsortiert = [...liste].sort(
    (a, b) => a.rang - b.rang || vergleicheId(a.eintrag.id, b.eintrag.id),
  );
  const element = new Map(vorsortiert.map((g) => [g.eintrag, g]));
  return sortEintraege(vorsortiert.map((g) => g.eintrag)).map((e) => element.get(e)!);
}

/** Vollständige Kontrollsicht (CSV-Export, Tagesabschluss). */
export async function loadKontrollbuch(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchOptions,
): Promise<FristEintrag[]> {
  const { kontext, laeufe } = await vorbereiten(tx, session, opts);
  // Offen ohne untere Grenze ODER erledigt im Fenster — je Quelle als OR
  // ausgedrückt, da „erledigt" quellspezifisch ist.
  const zeilen = await Promise.all(
    laeufe.map(({ quelle, filter }) => quelle.query(tx, filter.fenster)),
  );
  const kandidaten = laeufe.flatMap(({ quelle }, i) => zeilen[i]!.map((row) => ({ quelle, row })));
  const personen = await ladePersonen(tx, kandidaten, kontext.nurStaffId);
  return ordnen(abbilden(kandidaten, personen)).map((g) => g.eintrag);
}

// --- Seitenansicht ------------------------------------------------------------

export interface KontrollbuchSeitenOptionen extends KontrollbuchOptions {
  /** Angefragte Seite der offenen Einträge (1-basiert, auf die letzte Seite begrenzt). */
  seite: number;
  /** Angefragte Seite der erledigten Einträge (1-basiert, auf die letzte Seite begrenzt; Standard 1). */
  erledigtSeite?: number;
  /** Einträge je Seite, für offene und erledigte getrennt; 0 lädt nur die Zählwerte. */
  seitenGroesse: number;
  /** Zählwerte des Tagesabschlusses mitliefern, soweit der Umfang sie abdeckt. */
  tagesabschluss?: boolean;
}

/** Offene Einträge bis einschließlich Stichtag und davon überfällige. */
export interface Stichtagszaehler {
  offen: number;
  ueberfaellig: number;
}

export interface KontrollbuchSeite {
  /** Stichtag der Abfrage (UTC-Mitternacht des Berlin-Kalendertags). */
  heute: Date;
  /** Offene Einträge der Seite, dringlichste zuerst. */
  offen: FristEintrag[];
  /** Als erledigt abgeleitete Einträge der Seite `erledigtSeite`, neueste Fälligkeit zuerst. */
  erledigt: FristEintrag[];
  offenGesamt: number;
  /** Offene Einträge mit Fälligkeit vor dem Stichtag (gesamt, nicht nur die Seite). */
  ueberfaellig: number;
  /** Erledigte Einträge über alle Seiten. */
  erledigtGesamt: number;
  seite: number;
  erledigtSeite: number;
  seitenGroesse: number;
  /**
   * Zählwerte des Tagesabschlusses (offener Quellzweig bis einschließlich
   * Stichtag), wenn angefordert und die Seite alle Quellen ohne
   * Zuständigkeitsfilter umfasst; sonst null.
   */
  tagesabschluss: Stichtagszaehler | null;
}

interface Teilergebnis {
  /** Sicher offene Zeilen (`offen`) gesamt, vor dem Stichtag und bis einschließlich Stichtag. */
  gesamt: number;
  vorStichtag: number;
  bisStichtag: number;
  /** Sicher erledigte Zeilen (`erledigt`) gesamt. */
  erledigtGesamt: number;
  /**
   * Vollständig geladene Zeilen, deren Zustand erst `toEintrag` entscheidet;
   * `vorbehalt` markiert die aus dem offenen Zweig (`offenVorbehalt`).
   */
  zusatz: Array<Geordnet & { vorbehalt: boolean }>;
}

/** Vorläufige Abbildung ohne Personen: genügt für Zustand, Fälligkeit und Ordnung. */
const OHNE_PERSONEN: Personen = { name: () => null, hauptbearbeiter: () => null };

async function ladeTeile(
  tx: TxClient,
  { quelle, filter }: Quelllauf,
  heute: Date,
  stichtag: boolean,
): Promise<Teilergebnis> {
  const [gesamt, vorStichtag, bisStichtag, erledigtGesamt, vorbehalt, erledigtVorbehalt] =
    await Promise.all([
      quelle.count(tx, filter.offen),
      quelle.count(tx, filter.offen, { lt: heute }),
      stichtag ? quelle.count(tx, filter.offen, { lte: heute }) : 0,
      filter.erledigt ? quelle.count(tx, filter.erledigt) : 0,
      filter.offenVorbehalt ? quelle.query(tx, filter.offenVorbehalt) : [],
      filter.erledigtVorbehalt ? quelle.query(tx, filter.erledigtVorbehalt) : [],
    ]);
  const vorlauf = (rows: unknown[], istVorbehalt: boolean) =>
    abbilden(
      rows.map((row) => ({ quelle, row })),
      OHNE_PERSONEN,
    ).map((g) => ({ ...g, vorbehalt: istVorbehalt }));
  return {
    gesamt,
    vorStichtag,
    bisStichtag,
    erledigtGesamt,
    zusatz: [...vorlauf(vorbehalt, true), ...vorlauf(erledigtVorbehalt, false)],
  };
}

function summe(
  teile: readonly Teilergebnis[],
  feld: 'gesamt' | 'vorStichtag' | 'bisStichtag' | 'erledigtGesamt',
) {
  return teile.reduce((total, teil) => total + teil[feld], 0);
}

function zaehle(
  teile: readonly Teilergebnis[],
  zusatzOffen: ReadonlyArray<Geordnet & { vorbehalt: boolean }>,
  zusatzErledigt: readonly Geordnet[],
  heute: Date,
  stichtag: boolean,
) {
  const vor = (g: Geordnet) => g.eintrag.faelligAm.getTime() < heute.getTime();
  const bis = (g: Geordnet) => g.eintrag.faelligAm.getTime() <= heute.getTime();
  // Der Tagesabschluss liest nur den offenen Quellzweig: Zusatzzeilen aus dem
  // Rückschau-Zweig zählen für die Seite, aber nicht für den Abschluss.
  const vorbehalt = zusatzOffen.filter((g) => g.vorbehalt);
  const ueberfaellig = summe(teile, 'vorStichtag');
  return {
    offenGesamt: summe(teile, 'gesamt') + zusatzOffen.length,
    ueberfaellig: ueberfaellig + zusatzOffen.filter(vor).length,
    erledigtGesamt: summe(teile, 'erledigtGesamt') + zusatzErledigt.length,
    tagesabschluss: stichtag
      ? {
          offen: summe(teile, 'bisStichtag') + vorbehalt.filter(bis).length,
          ueberfaellig: ueberfaellig + vorbehalt.filter(vor).length,
        }
      : null,
  };
}

function begrenzeSeite(angefragt: number, gesamt: number, seitenGroesse: number): number {
  const letzte = seitenGroesse > 0 ? Math.max(1, Math.ceil(gesamt / seitenGroesse)) : 1;
  const seite = Number.isSafeInteger(angefragt) && angefragt >= 1 ? angefragt : 1;
  return Math.min(seite, letzte);
}

/**
 * Seitenansicht, offene und erledigte Einträge getrennt geblättert. Je Quelle
 * werden nur die ersten `seite × seitenGroesse` sicher offenen Zeilen nach
 * Fälligkeit (aufsteigend) und die ersten `erledigtSeite × seitenGroesse`
 * sicher erledigten Zeilen (Fälligkeit absteigend) geladen. Die kleinen
 * Vorbehalte, deren Zustand erst `toEintrag` entscheidet (verspätete bzw. laut
 * Vorabfrage fristgerechte Einlegungen), werden vollständig geladen und nach
 * ihrem abgeleiteten Zustand eingeordnet. Gesamtzahlen kommen aus
 * `count`-Abfragen mit demselben Filter. Alle Seiten zusammen ergeben genau die
 * Einträge von `loadKontrollbuch` in derselben Reihenfolge.
 */
export async function loadKontrollbuchSeite(
  tx: TxClient,
  session: StaffSession,
  opts: KontrollbuchSeitenOptionen,
): Promise<KontrollbuchSeite> {
  const { kontext, laeufe } = await vorbereiten(tx, session, opts);
  const { heute } = kontext;
  const stichtag =
    Boolean(opts.tagesabschluss) &&
    kontext.nurStaffId === null &&
    laeufe.length === KONTROLLBUCH_QUELLEN.length;
  const teile = await Promise.all(laeufe.map((lauf) => ladeTeile(tx, lauf, heute, stichtag)));
  const zusatz = teile.flatMap((teil) => teil.zusatz);
  const zusatzOffen = zusatz.filter((g) => !g.eintrag.erledigt);
  const zusatzErledigt = zusatz.filter((g) => g.eintrag.erledigt);
  const zaehler = zaehle(teile, zusatzOffen, zusatzErledigt, heute, stichtag);
  const seitenGroesse = Math.max(0, opts.seitenGroesse);
  const seite = begrenzeSeite(opts.seite, zaehler.offenGesamt, seitenGroesse);
  const erledigtSeite = begrenzeSeite(
    opts.erledigtSeite ?? 1,
    zaehler.erledigtGesamt,
    seitenGroesse,
  );
  const ergebnis = { heute, ...zaehler, seite, erledigtSeite, seitenGroesse };
  if (seitenGroesse === 0) return { ...ergebnis, offen: [], erledigt: [] };

  const bis = seite * seitenGroesse;
  const erledigtBis = erledigtSeite * seitenGroesse;
  const [sicherOffen, sicherErledigt] = await Promise.all([
    Promise.all(
      laeufe.map(({ quelle, filter }, i) =>
        teile[i]!.gesamt > 0 ? quelle.query(tx, filter.offen, { take: bis }) : [],
      ),
    ),
    Promise.all(
      laeufe.map(({ quelle, filter }, i) =>
        filter.erledigt && teile[i]!.erledigtGesamt > 0
          ? quelle.query(tx, filter.erledigt, { take: erledigtBis, absteigend: true })
          : [],
      ),
    ),
  ]);
  const vorlaeufig = (zeilen: readonly unknown[][]) =>
    laeufe.flatMap(({ quelle }, i) =>
      abbilden(
        zeilen[i]!.map((row) => ({ quelle, row })),
        OHNE_PERSONEN,
      ),
    );
  const seitenOffen = ordnen([...vorlaeufig(sicherOffen), ...zusatzOffen]).slice(
    bis - seitenGroesse,
    bis,
  );
  const seitenErledigt = ordnen([...vorlaeufig(sicherErledigt), ...zusatzErledigt]).slice(
    erledigtBis - seitenGroesse,
    erledigtBis,
  );
  const personen = await ladePersonen(
    tx,
    [...seitenOffen, ...seitenErledigt].map((g) => g.kandidat),
    kontext.nurStaffId,
  );
  const endgueltig = (liste: readonly Geordnet[]) =>
    abbilden(
      liste.map((g) => g.kandidat),
      personen,
    ).map((g) => g.eintrag);
  return { ...ergebnis, offen: endgueltig(seitenOffen), erledigt: endgueltig(seitenErledigt) };
}

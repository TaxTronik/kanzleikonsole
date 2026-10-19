// =============================================================================
// Akteursabbildung kanzleikonsole → Tax-CMS (TCMS Stufe 2; ADR 0001 §3.2,
// §3.3, §5 im TCMS-Repo). Sicherheitskritisch.
//
// Die Akteursbestätigung sagt dem TCMS, wer handelt, welche Rollen die Person
// hat und auf welche Mandanten sie zugreifen darf. Das TCMS leitet daraus
// seine Rechte ab (kannLesen, kannBearbeiten, kannWuerdigen). Deshalb gilt:
// - Quelle ist ausschließlich die serverseitig geprüfte Sitzung (staffAuth/
//   portalAuth) und der aktuelle Datenbestand der kanzleikonsole – nie
//   Formular- oder Clientdaten. Der einzige Eingabewert ist die Mandanten-ID
//   des Aufrufziels; für sie wird der Zugriff geprüft.
// - Bestätigt wird nie mehr, als die kanzleikonsole selbst gewährt. Dafür
//   laufen ausschließlich die vorhandenen Prüfungen der kanzleikonsole:
//   Mandantenzugriff `canStaffAccessClientTx` (ACCESS-CLIENT-MODE-001,
//   gemeinsame Policy für Web und Worker, mit frischen Rollen und
//   Existenzprüfung des Mandanten), Listen `accessibleClientsWhereFor`,
//   zuständige Berufsträgerin `canStaffReviewGwgTx` (Zuordnung BERUFSTRAEGER
//   und aktuell qualifiziert), Portalzugang `findPortalProfilesForContactTx`.
// - Personen werden je Bestätigung frisch geladen: deaktivierte oder
//   tenantfremde Personen, abgelaufene Sitzungen und Sitzungen mit veraltetem
//   Rollenstand erhalten keine Bestätigung; es kommt dann auch zu keinem Aufruf.
//   Die Login-Sperre (`lockedUntil`) zählt bewusst nicht: Sie sperrt in der
//   kanzleikonsole nur neue Passwort-Anmeldungen, laufende Sitzungen bleiben
//   gültig. Würde sie hier greifen, könnte jeder, der die E-Mail-Adresse kennt,
//   einer angemeldeten Person per Fehlversuchen das TCMS sperren (TCMS Stufe 2).
//
// Abbildung (Begründung in docs/development/tcms-anbindung.md, Abschnitt 4):
//   Kanzleiperson → knd KANZLEI, tnt Tenant, sub StaffUser-ID, nam Anzeigename,
//     rol.adm = ADMIN oder PARTNER (isStaffAdmin), rol.bt = isProfessional,
//     cli nur mit Mandantenzugriff: bt = zuständige Berufsträgerin,
//     hb = Hauptbearbeitung (ClientResponsibility).
//   Mandantenkontakt → knd MANDANT, sub Kontakt-ID, cli = Mandant der
//     Portal-Sitzung mit bt/hb false, nur aktive Kontakte mit Portalzugang.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import { canStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import type { TcmsAkteurAngaben } from '@taxtronik/tcms-client';
import { MAX_MANDANTEN_JE_ANFRAGE, type MandantenListe } from '@taxtronik/tcms-contract';
import { ForbiddenError, UnauthorizedError } from '@/server/actions/action-error';
import { accessibleClientsWhereFor, isStaffAdmin, requireStaffSession } from '@/server/auth/rbac';
import { portalAuth, type PortalSession } from '@/server/auth/portal';
import { findPortalProfilesForContactTx } from '@/server/auth/portal-profiles';
import type { StaffSession } from '@/server/auth/staff';
import { canStaffReviewGwgTx } from '@/server/gwg/professional-review';
import { tcmsTextBereinigen } from './zeichen';

export type TcmsVerweigerungsGrund =
  | 'SITZUNG_UNGUELTIG'
  | 'SITZUNG_ABGELAUFEN'
  | 'SITZUNG_VERALTET'
  | 'PERSON_INAKTIV'
  | 'NAME_UNGUELTIG'
  | 'KEIN_MANDANTENZUGRIFF'
  | 'ZU_VIELE_MANDANTEN'
  | 'KEIN_PORTALZUGANG';

/** Keine Bestätigung: die Meldung ist UI-tauglich, der Grund nur für Logs und Tests. */
export class TcmsAkteurVerweigert extends ForbiddenError {
  readonly grund: TcmsVerweigerungsGrund;
  constructor(grund: TcmsVerweigerungsGrund) {
    super('Kein Zugriff auf das Tax-CMS.');
    this.name = 'TcmsAkteurVerweigert';
    this.grund = grund;
  }
}

export interface AbbildungsOptionen {
  /** Zeitpunkt der Prüfung (Tests); Standard: jetzt. */
  jetzt?: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUALIFIZIERTE_ZUSTAENDIGKEIT = ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] as const;
/** Grenze von `nam` im Vertrag (UTF-16-Codeeinheiten wie zod `max`). */
const MAX_NAME = 200;

function verweigert(grund: TcmsVerweigerungsGrund): TcmsAkteurVerweigert {
  return new TcmsAkteurVerweigert(grund);
}

function istUuid(wert: unknown): wert is string {
  return typeof wert === 'string' && UUID.test(wert);
}

function pruefeAblauf(expires: unknown, jetzt: Date): void {
  const ende = typeof expires === 'string' ? Date.parse(expires) : Number.NaN;
  if (!Number.isFinite(ende) || ende <= jetzt.getTime()) throw verweigert('SITZUNG_ABGELAUFEN');
}

/**
 * Anzeigename für `nam`: mit der Zeichenregel des Vertrags still bereinigt
 * (TCMS s8, server/tcms/zeichen.ts – der Dienst prüft `nam` nicht selbst),
 * getrimmt, höchstens 200 Codeeinheiten, ohne halbe Surrogate. Dieselbe
 * Funktion liefert die Namen, die die kanzleikonsole in Bodies sendet
 * (Zuständigkeit, Freigabe-Namen, Ansprechperson einer Meldung).
 */
export function anzeigename(roh: string): string {
  const name = tcmsTextBereinigen(roh, 'EINZEILIG', MAX_NAME);
  if (name === '') throw verweigert('NAME_UNGUELTIG');
  return name;
}

function gleicheMenge(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((wert) => y.has(wert));
}

interface Person {
  tenantId: string;
  staffId: string;
  istAdmin: boolean;
  name: string;
  istBerufstraeger: boolean;
}

/**
 * Lädt die Kanzleiperson frisch und prüft Sitzung, Aktivität, Tenant
 * und Rollenstand. `rol.adm` kommt aus `isStaffAdmin(session)`, nachdem
 * feststeht, dass die Rollen der Sitzung exakt dem aktuellen Stand entsprechen.
 */
async function ladePerson(tx: TxClient, session: StaffSession, jetzt: Date): Promise<Person> {
  const { tenantId, staffId, roles } = session.user ?? ({} as StaffSession['user']);
  if (!istUuid(tenantId) || !istUuid(staffId) || !Array.isArray(roles)) {
    throw verweigert('SITZUNG_UNGUELTIG');
  }
  pruefeAblauf(session.expires, jetzt);
  const staff = await tx.staffUser.findFirst({
    where: { id: staffId, tenantId, active: true },
    select: {
      fullName: true,
      isProfessional: true,
      roles: { select: { role: true } },
    },
  });
  if (!staff) throw verweigert('PERSON_INAKTIV');
  if (
    !gleicheMenge(
      roles,
      staff.roles.map((r) => r.role as string),
    )
  ) {
    throw verweigert('SITZUNG_VERALTET');
  }
  return {
    tenantId,
    staffId,
    istAdmin: isStaffAdmin(session),
    name: anzeigename(staff.fullName),
    istBerufstraeger: staff.isProfessional,
  };
}

function kanzleiAngaben(person: Person): TcmsAkteurAngaben {
  return {
    tnt: person.tenantId,
    sub: person.staffId,
    knd: 'KANZLEI',
    nam: person.name,
    rol: { adm: person.istAdmin, bt: person.istBerufstraeger },
  };
}

/**
 * Akteur einer Kanzleiperson, mit `cli` genau dann, wenn `mandantId` angegeben
 * ist und die Person nach den Regeln der kanzleikonsole auf diesen Mandanten
 * zugreifen darf; sonst `TcmsAkteurVerweigert` (kein Aufruf). Ohne `mandantId`
 * entsteht ein Akteur ohne Mandantenbezug (z. B. Audit des Tenants).
 */
export async function kanzleiAkteurTx(
  tx: TxClient,
  session: StaffSession,
  opts: AbbildungsOptionen & { mandantId?: string } = {},
): Promise<TcmsAkteurAngaben> {
  const person = await ladePerson(tx, session, opts.jetzt ?? new Date());
  const angaben = kanzleiAngaben(person);
  if (opts.mandantId === undefined) return angaben;

  const mandantId = opts.mandantId;
  if (
    !istUuid(mandantId) ||
    !(await canStaffAccessClientTx(tx, person.tenantId, person.staffId, mandantId))
  ) {
    throw verweigert('KEIN_MANDANTENZUGRIFF');
  }
  const bt = await canStaffReviewGwgTx(tx, {
    tenantId: person.tenantId,
    clientId: mandantId,
    staffId: person.staffId,
  });
  const hb =
    (await tx.clientResponsibility.findFirst({
      where: {
        tenantId: person.tenantId,
        clientId: mandantId,
        staffId: person.staffId,
        role: 'HAUPTBEARBEITER',
      },
      select: { id: true },
    })) !== null;
  return { ...angaben, cli: { id: mandantId, bt, hb } };
}

/**
 * Akteur ohne `cli` plus die Liste der zugreifbaren Mandanten mit `bt`/`hb`
 * für mandantenübergreifende Lesepfade (Portfolio, Arbeitskorb; ADR §3.3). Die
 * Liste gehört in den Body und ist über `req.b` gebunden. Mehr als
 * `MAX_MANDANTEN_JE_ANFRAGE` Mandanten: keine Bestätigung statt stiller Kürzung.
 */
export async function kanzleiMandantenListeTx(
  tx: TxClient,
  session: StaffSession,
  opts: AbbildungsOptionen = {},
): Promise<{ akteur: TcmsAkteurAngaben; liste: Required<MandantenListe> }> {
  const person = await ladePerson(tx, session, opts.jetzt ?? new Date());
  const sichtbar = await accessibleClientsWhereFor(tx, session);
  const mandanten = await tx.client.findMany({
    where: { AND: [{ tenantId: person.tenantId }, sichtbar] },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_MANDANTEN_JE_ANFRAGE + 1,
  });
  if (mandanten.length > MAX_MANDANTEN_JE_ANFRAGE) throw verweigert('ZU_VIELE_MANDANTEN');
  const mandantIds = mandanten.map((m) => m.id);
  const zugreifbar = new Set(mandantIds);

  // Dieselben Bedingungen wie canStaffReviewGwgTx (bt) bzw. die
  // HAUPTBEARBEITER-Zuordnung (hb), als eine Abfrage für alle Mandanten; ein
  // Differenztest (akteur-db.test.ts) hält beide deckungsgleich.
  const zuordnungen = await tx.clientResponsibility.findMany({
    where: {
      tenantId: person.tenantId,
      staffId: person.staffId,
      role: { in: [...QUALIFIZIERTE_ZUSTAENDIGKEIT] },
    },
    select: {
      clientId: true,
      role: true,
      staff: {
        select: {
          tenantId: true,
          active: true,
          isProfessional: true,
          roles: { select: { role: true }, take: 1 },
        },
      },
    },
  });
  const bt = new Set<string>();
  const hb = new Set<string>();
  for (const z of zuordnungen) {
    if (!zugreifbar.has(z.clientId)) continue;
    if (z.role === 'HAUPTBEARBEITER') hb.add(z.clientId);
    else if (
      z.staff.tenantId === person.tenantId &&
      z.staff.active &&
      z.staff.isProfessional &&
      z.staff.roles.length > 0
    ) {
      bt.add(z.clientId);
    }
  }
  const sortiert = (menge: Set<string>) => mandantIds.filter((id) => menge.has(id));
  return {
    akteur: kanzleiAngaben(person),
    liste: { mandantIds, bt: sortiert(bt), hb: sortiert(hb) },
  };
}

/**
 * Akteur eines Mandantenkontakts aus der Portal-Sitzung: nur aktive Kontakte
 * mit Portalzugang (aktiver Kontakt, Mandant zugelassen, nicht anonymisiert,
 * Mandat nicht beendet, E-Mail der Sitzung) und nur für den Mandanten der
 * Sitzung.
 */
export async function portalAkteurTx(
  tx: TxClient,
  session: PortalSession,
  opts: AbbildungsOptionen = {},
): Promise<TcmsAkteurAngaben> {
  const { tenantId, contactId, clientId, email } = session.user ?? ({} as PortalSession['user']);
  if (
    !istUuid(tenantId) ||
    !istUuid(contactId) ||
    !istUuid(clientId) ||
    typeof email !== 'string'
  ) {
    throw verweigert('SITZUNG_UNGUELTIG');
  }
  pruefeAblauf(session.expires, opts.jetzt ?? new Date());
  const profile = await findPortalProfilesForContactTx(tx, { tenantId, contactId, email });
  const eigenes = profile.find((p) => p.contactId === contactId && p.clientId === clientId);
  if (!eigenes) throw verweigert('KEIN_PORTALZUGANG');
  return {
    tnt: tenantId,
    sub: contactId,
    knd: 'MANDANT',
    nam: anzeigename(eigenes.contactName),
    cli: { id: clientId, bt: false, hb: false },
  };
}

// ---------------------------------------------------------------------------
// Einstiege mit eigener Sitzungsprüfung (für Server-Aktionen und Routen).
// ---------------------------------------------------------------------------

async function staffSitzung(): Promise<StaffSession> {
  return requireStaffSession();
}

function staffKontext(session: StaffSession) {
  return {
    tenantId: session.user.tenantId,
    actorId: session.user.staffId,
    actorType: 'STAFF' as const,
  };
}

/** Akteur der angemeldeten Kanzleiperson, optional mit geprüftem Mandantenbezug. */
export async function kanzleiAkteur(opts: { mandantId?: string } = {}): Promise<TcmsAkteurAngaben> {
  const session = await staffSitzung();
  return withTenantContext(staffKontext(session), (tx) => kanzleiAkteurTx(tx, session, opts));
}

/** Akteur und Mandantenliste der angemeldeten Kanzleiperson (Portfolio, Arbeitskorb). */
export async function kanzleiMandantenListe(): Promise<{
  akteur: TcmsAkteurAngaben;
  liste: Required<MandantenListe>;
}> {
  const session = await staffSitzung();
  return withTenantContext(staffKontext(session), (tx) => kanzleiMandantenListeTx(tx, session));
}

/** Akteur des angemeldeten Mandantenkontakts (Portal-Endpunkte des TCMS). */
export async function portalAkteur(): Promise<TcmsAkteurAngaben> {
  const session = await portalAuth();
  if (!session) throw new UnauthorizedError();
  return withTenantContext(
    {
      tenantId: session.user.tenantId,
      actorId: session.user.contactId,
      actorType: 'CLIENT_CONTACT',
    },
    (tx) => portalAkteurTx(tx, session),
  );
}

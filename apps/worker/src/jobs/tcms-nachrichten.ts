// =============================================================================
// Zustellung der Mitteilungen des Tax-CMS (TCMS Stufe 4; MAIL-OUTBOX-001)
//
// Das Tax-CMS legt Mitteilungen ab (Freigabe angefordert, Bestätigungscode,
// Neuadressierung an Mandantenkontakte; gemeldetes Ereignis an
// Kanzleipersonen), stellt sie aber nicht selbst zu. Je Tenant mit aktivem
// Modul (isWorkerTcmsActive) und je Lauf höchstens einmal gleichzeitig
// (Lease in tcms_systemakteur):
//
//   1. Abruf `GET /v1/nachrichten/offen?limit=50` mit dem Systemakteur.
//   2. Je Mitteilung EINE Tenant-Transaktion: Zustellzeile sperren bzw.
//      eindeutig anlegen (tcms_nachricht_zustellung, Tenant + Nachrichten-ID),
//      Empfänger allein aus den Daten der kanzleikonsole prüfen und einplanen:
//      Kontakte über die Mail-Outbox (Transaktionsmail, Code nur als geheime
//      Variable), Kanzleipersonen als In-App-Hinweis.
//   3. Erst nach dem Commit melden: eingeplant → `POST …/zugestellt`,
//      unzustellbar → `POST …/unzustellbar` mit festem Grund (TCMS s6); 404
//      und 409 = erledigt. Ein anderer Fehler lässt die Zeile ungemeldet: Der
//      nächste Lauf sieht die Mitteilung wieder, findet die Zeile und meldet
//      nur – nie eine zweite Einplanung, nie ein anderer Grund. Antwortet der
//      Dienst auf „zugestellt“ mit 409 (TCMS s8: im Tax-CMS verworfen, bevor
//      sie ausgeliefert wurde, oder anders abgeschlossen), wird die Mail nicht
//      versendet: Ein noch wartender Auftrag endet als SKIPPED (Inhalt und
//      Code entfernt); ein Auftrag, dessen Versand schon läuft oder erfolgt
//      ist, bleibt unberührt.
//
// Das Tax-CMS reserviert beim Abruf nichts; zwei gleichzeitige Läufe sähen
// dieselbe Mitteilung. Doppelte schließen der eindeutige Schlüssel der
// Zustellzeile (INSERT … ON CONFLICT DO NOTHING bzw. FOR UPDATE), der
// partielle eindeutige Index der Outbox (eine Mail je Zeile) und der Lease aus.
//
// Empfängerregeln (fail closed, Gründe als feste Codes):
//   - Mandant: im Tenant vorhanden; für Kontakte zugelassen, nicht beendet,
//     nicht anonymisiert.
//   - KONTAKT: Kontakt dieses Tenants, gehört zu genau diesem Mandanten, aktiv,
//     gültige E-Mail, per Portal-Anmeldung bestätigt (`lastLoginAt`). Die
//     Mitteilungen sind Transaktionsmails zu einem Vorgang, den der Kontakt
//     selbst ausgelöst hat oder der ihn als Empfänger nennt; deshalb gelten
//     die Benachrichtigungs-Einstellungen des Kontakts nicht. Weil ein Code
//     eine Freigabe bestätigt, geht er nur an eine Adresse, deren Inhaber
//     sich nachweislich angemeldet hat – nie an eine Adresse aus dem Tax-CMS
//     (dessen Mitteilungen tragen keine).
//   - KANZLEI: aktive Person dieses Tenants mit Zugriff auf den Mandanten
//     (canStaffAccessClientTx, ACCESS-CLIENT-MODE-001).
// Scheitert eine Prüfung: nicht einplanen, nicht melden, einmal je Mitteilung
// ein In-App-Hinweis an die ADMIN/PARTNER (ohne Inhalt und Code), Log ohne
// personenbezogene Daten. Jeder Lauf prüft erneut; nach
// TCMS_UNZUSTELLBAR_NACH_TAGEN als UNZUSTELLBAR abschließen und dem Tax-CMS
// als unzustellbar melden (sonst blockierte die Mitteilung den
// ältesten-zuerst-Abruf dauerhaft). Der gemeldete Grund folgt fest aus dem
// gespeicherten Grund der Zeile (TCMS_MELDEGRUND) und steht damit vor dem
// ersten Senden fest; eine Wiederholung sendet denselben Grund. Das Tax-CMS
// zeigt der Kanzlei daraufhin „unzustellbar“ an der Freigabe (Neuadressierung).
// Gültigkeitsfenster: ein Code bis `gueltigBis`, eine Anforderung bzw.
// Neuadressierung TCMS_NACHRICHT_FENSTER_TAGE ab Anlage; danach ABGELAUFEN
// (abschließen und melden, kein Versand). Die Mail-Outbox prüft dasselbe
// Fenster und den Empfänger vor jedem Versandversuch erneut.
//
// Nie im Log, in Hinweisen oder Fehlermeldungen: Code, Text, Betreff, Titel,
// Namen, Adressen, Mandanten- oder Personen-IDs.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { canStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { enqueueDirectMailTx } from '@taxtronik/mail/outbox';
import {
  TCMS_FREIGABE_ART_LABEL,
  TCMS_MAIL_VORLAGEN,
  TCMS_NACHRICHT_RESSOURCE,
  type TcmsMailAnlass,
} from '@taxtronik/mail/tcms-vorlagen';
import {
  MELDUNG_UNGESENDET_AUFBEWAHRUNG_MS,
  MELDUNG_WIEDERHOLUNG_FENSTER_MS,
  TcmsFehler,
  TcmsKonflikt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
  type NachrichtUnzustellbarGrund,
  type OffeneNachricht,
  type TcmsAkteurAngaben,
} from '@taxtronik/tcms-client';
import { resolveClientWarningRecipientsTx } from '../notification-recipients';
import type { NotifyInput, NotifyOptions } from '../notify';
import type { TcmsPostausgang } from '../tcms/dienst';
import { beanspruche, type LeaseDb } from '../tcms/systemakteur';

/**
 * Mitteilungen je Abruf (Vertrag: 1–100, Standard 50). Entscheidung zum
 * Hinweis aus RT3B: bei 50 bleiben – ein Lauf je Minute und Tenant mit je
 * Mitteilung einer Transaktion und einem Dienstaufruf hält die Lease kurz;
 * der Rest folgt im nächsten Lauf. Eine Antwort mit mehr Mitteilungen als
 * angefragt weist der Postausgang ab (tcms/dienst.ts).
 */
export const TCMS_ZUSTELL_LIMIT = 50;
/**
 * Gültigkeitsfenster einer Anforderung bzw. Neuadressierung ab Anlage im
 * Tax-CMS: so lange wie ein Bestätigungscode gilt (CODE_GUELTIG_TAGE im
 * TCMS-Repo). Danach ist der Hinweis überholt.
 */
export const TCMS_NACHRICHT_FENSTER_TAGE = 7;
/**
 * Nach so vielen Tagen ab der ersten gescheiterten Prüfung wird eine
 * Mitteilung als unzustellbar abgeschlossen und dem Tax-CMS als erledigt
 * gemeldet. Entscheidung (TCMS Stufe 4): gleich der Code-Lebensdauer – danach
 * ist jeder Code ungültig und jede Anforderung außerhalb ihres Fensters; die
 * Frist deckt ein Wochenende plus Abwesenheit ab, um Kontaktdaten zu
 * korrigieren (der Hinweis an die Admins nennt sie). Länger offen gehaltene
 * Mitteilungen belegten den ältesten-zuerst-Abruf (Limit 50) und verdrängten
 * neue.
 */
export const TCMS_UNZUSTELLBAR_NACH_TAGEN = 7;
/** Gemeldete bzw. lange nicht mehr gesehene Zustellzeilen werden danach gelöscht. */
export const TCMS_ZUSTELLUNG_AUFBEWAHRUNG_TAGE = 30;
const TAG_MS = 24 * 60 * 60_000;

/** Feste Gründe (CHECK in der Migration), ohne personenbezogene Angaben. */
export const TCMS_ZUSTELL_GRUENDE = {
  ABGELAUFEN: 'Die Mitteilung war beim Abruf bereits abgelaufen.',
  MANDANT_UNBEKANNT: 'Der Mandant ist in TaxTronik nicht (mehr) vorhanden.',
  MANDANT_INAKTIV: 'Der Mandant ist gesperrt, beendet oder anonymisiert.',
  KONTAKT_UNBEKANNT: 'Der Empfänger ist kein Kontakt dieser Kanzlei.',
  KONTAKT_ANDERER_MANDANT: 'Der Empfänger ist kein Kontakt dieses Mandanten.',
  KONTAKT_INAKTIV: 'Der Kontakt ist deaktiviert.',
  KONTAKT_OHNE_EMAIL: 'Der Kontakt hat keine gültige E-Mail-Adresse.',
  KONTAKT_UNBESTAETIGT:
    'Die E-Mail-Adresse des Kontakts ist nicht bestätigt (noch keine Anmeldung im Mandantenportal).',
  PERSON_UNBEKANNT: 'Die Kanzleiperson ist in TaxTronik nicht vorhanden.',
  PERSON_INAKTIV: 'Die Kanzleiperson ist deaktiviert.',
  PERSON_OHNE_ZUGRIFF: 'Die Kanzleiperson hat keinen Zugriff auf diesen Mandanten.',
} as const;
export type TcmsZustellGrund = keyof typeof TCMS_ZUSTELL_GRUENDE;

/**
 * Grund der Meldung „unzustellbar“ an das Tax-CMS je eigenem Grund (feste
 * Abbildung, vollständig per `satisfies`): Empfänger unbekannt, bei einem
 * anderen Mandanten bzw. als Kanzleiperson deaktiviert oder ohne Zugriff →
 * EMPFAENGER_UNGUELTIG; Kontakt ohne bestätigten Zugang (keine Anmeldung,
 * deaktiviert, keine gültige Adresse) → KEIN_PORTALZUGANG; Fenster der
 * Mitteilung abgelaufen → ABGELAUFEN; Mandant fehlt oder ist nicht aktiv →
 * SONSTIGES. Nach Ablauf von TCMS_UNZUSTELLBAR_NACH_TAGEN bleibt der Grund der
 * letzten Prüfung maßgeblich (er sagt der Kanzlei, was zu korrigieren ist).
 */
export const TCMS_MELDEGRUND = {
  ABGELAUFEN: 'ABGELAUFEN',
  MANDANT_UNBEKANNT: 'SONSTIGES',
  MANDANT_INAKTIV: 'SONSTIGES',
  KONTAKT_UNBEKANNT: 'EMPFAENGER_UNGUELTIG',
  KONTAKT_ANDERER_MANDANT: 'EMPFAENGER_UNGUELTIG',
  KONTAKT_INAKTIV: 'KEIN_PORTALZUGANG',
  KONTAKT_OHNE_EMAIL: 'KEIN_PORTALZUGANG',
  KONTAKT_UNBESTAETIGT: 'KEIN_PORTALZUGANG',
  PERSON_UNBEKANNT: 'EMPFAENGER_UNGUELTIG',
  PERSON_INAKTIV: 'EMPFAENGER_UNGUELTIG',
  PERSON_OHNE_ZUGRIFF: 'EMPFAENGER_UNGUELTIG',
} as const satisfies Readonly<Record<TcmsZustellGrund, NachrichtUnzustellbarGrund>>;

/** Meldegrund einer abgeschlossenen Zeile; unbekannte Werte (nur bei Drift) → SONSTIGES. */
export function meldegrund(grund: string | null): NachrichtUnzustellbarGrund {
  return grund !== null && Object.hasOwn(TCMS_MELDEGRUND, grund)
    ? TCMS_MELDEGRUND[grund as TcmsZustellGrund]
    : 'SONSTIGES';
}

const ZWECK_LABEL: Readonly<Record<OffeneNachricht['zweck'], string>> = {
  FREIGABE_ANGEFORDERT: 'Freigabe angefordert',
  FREIGABE_CODE: 'Bestätigungscode',
  FREIGABE_NEU_ADRESSIERT: 'Freigabe neu adressiert',
  EREIGNIS_GEMELDET: 'Ereignis gemeldet',
};

const MAIL_ANLASS: Readonly<Record<OffeneNachricht['zweck'], TcmsMailAnlass | null>> = {
  FREIGABE_ANGEFORDERT: 'tcms-freigabe-angefordert',
  FREIGABE_CODE: 'tcms-freigabe-code',
  FREIGABE_NEU_ADRESSIERT: 'tcms-freigabe-neu-adressiert',
  EREIGNIS_GEMELDET: null,
};

/** Pragmatische Adressprüfung wie im Formular (genau ein @, kein Leerraum). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Db = Prisma.TransactionClient;

export interface TcmsZustellDeps {
  /** Owner-Client: Tenants, Lease, Bereinigung. */
  db: LeaseDb & Pick<Db, 'tenant' | 'tcmsNachrichtZustellung' | 'tcmsPortalReport'>;
  /** Tenant-Transaktion (Owner, Tenant-Kontext gesetzt) für Prüfung und Einplanung. */
  runAtomic: <T>(tenantId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  /** Modul `tcms` an UND Dienst konfiguriert (isWorkerTcmsActive). */
  istAktiv: (tenantId: string) => Promise<boolean>;
  /** Postausgang über den Systemclient; `null` = Tax-CMS nicht konfiguriert. */
  postausgang: () => TcmsPostausgang | null;
  notify: (
    tx: Db,
    input: NotifyInput | readonly NotifyInput[],
    o?: NotifyOptions,
  ) => Promise<unknown>;
  /** Stößt mail-outbox-deliver nach dem Commit an (der Minutentakt holt Verlorenes nach). */
  kickMail: () => void;
  portalBaseUrl: string;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface TcmsZustellErgebnis {
  tenants: number;
  /** Tenants, deren Lauf ein anderer Lauf hielt. */
  gesperrt: number;
  abgerufen: number;
  eingeplant: number;
  zurueckgestellt: number;
  unzustellbar: number;
  gemeldet: number;
  /** Abruf oder Meldung gescheitert (nächster Lauf). */
  fehler: number;
  bereinigt: number;
  /** Meldevorgänge des Portals nach Ablauf des Wiederholungsfensters gelöscht (kk-tcms-s10nach). */
  meldungenBereinigt: number;
}

function leeresErgebnis(): TcmsZustellErgebnis {
  return {
    tenants: 0,
    gesperrt: 0,
    abgerufen: 0,
    eingeplant: 0,
    zurueckgestellt: 0,
    unzustellbar: 0,
    gemeldet: 0,
    fehler: 0,
    bereinigt: 0,
    meldungenBereinigt: 0,
  };
}

/** Log-Felder eines Fehlers: Klasse und Status, nie Inhalte des Dienstes. */
export function fehlerFelder(fehler: unknown): Record<string, string | number | null> {
  if (fehler instanceof TcmsFehler) {
    return {
      fehler: fehler.name,
      status: fehler.status,
      code: fehler.code,
      tcmsRequestId: fehler.requestId,
      ...(fehler instanceof TcmsNichtVerfuegbar || fehler instanceof TcmsProtokollFehler
        ? { grund: fehler.grund }
        : {}),
      ...(fehler instanceof TcmsUngueltig ? { lokal: fehler.lokal ? 1 : 0 } : {}),
    };
  }
  return { fehler: fehler instanceof Error ? fehler.name : 'unbekannt' };
}

const berlinZeit = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Ende des Gültigkeitsfensters einer Mitteilung; `null` = unbegrenzt (Ereignis). */
export function gueltigBis(n: OffeneNachricht): Date | null {
  if (n.zweck === 'EREIGNIS_GEMELDET') return null;
  const ende =
    n.zweck === 'FREIGABE_CODE'
      ? Date.parse(n.daten.gueltigBis)
      : Date.parse(n.erstelltAm) + TCMS_NACHRICHT_FENSTER_TAGE * TAG_MS;
  // Unlesbare Zeit: fail closed (sofort abgelaufen).
  return new Date(Number.isFinite(ende) ? ende : 0);
}

interface KontaktEmpfaenger {
  art: 'KONTAKT';
  mandantId: string;
  mandantName: string;
  kontaktId: string;
  name: string;
  email: string;
}
interface KanzleiEmpfaenger {
  art: 'KANZLEI';
  mandantId: string;
  staffId: string;
}
type Pruefung =
  | { ok: true; empfaenger: KontaktEmpfaenger | KanzleiEmpfaenger }
  | { ok: false; grund: TcmsZustellGrund; mandantVorhanden: boolean };

function abgelehnt(grund: TcmsZustellGrund, mandantVorhanden: boolean): Pruefung {
  return { ok: false, grund, mandantVorhanden };
}

/** Empfänger allein aus den Daten der kanzleikonsole bestätigen (Tenant-Filter selbst gesetzt). */
async function pruefeEmpfaenger(tx: Db, tenantId: string, n: OffeneNachricht): Promise<Pruefung> {
  const mandant = await tx.client.findFirst({
    where: { id: n.mandantId, tenantId },
    select: { id: true, name: true, allowActive: true, anonymizedAt: true, mandateEndedAt: true },
  });
  if (!mandant) return abgelehnt('MANDANT_UNBEKANNT', false);
  if (mandant.anonymizedAt) return abgelehnt('MANDANT_INAKTIV', true);

  if (n.empfaengerArt === 'KANZLEI') {
    const person = await tx.staffUser.findFirst({
      where: { id: n.empfaengerId, tenantId },
      select: { active: true },
    });
    if (!person) return abgelehnt('PERSON_UNBEKANNT', true);
    if (!person.active) return abgelehnt('PERSON_INAKTIV', true);
    if (!(await canStaffAccessClientTx(tx, tenantId, n.empfaengerId, mandant.id))) {
      return abgelehnt('PERSON_OHNE_ZUGRIFF', true);
    }
    return {
      ok: true,
      empfaenger: { art: 'KANZLEI', mandantId: mandant.id, staffId: n.empfaengerId },
    };
  }

  if (!mandant.allowActive || mandant.mandateEndedAt) return abgelehnt('MANDANT_INAKTIV', true);
  const kontakt = await tx.clientContact.findFirst({
    where: { id: n.empfaengerId, tenantId },
    select: { clientId: true, active: true, email: true, fullName: true, lastLoginAt: true },
  });
  if (!kontakt) return abgelehnt('KONTAKT_UNBEKANNT', true);
  if (kontakt.clientId !== mandant.id) return abgelehnt('KONTAKT_ANDERER_MANDANT', true);
  if (!kontakt.active) return abgelehnt('KONTAKT_INAKTIV', true);
  const email = kontakt.email.trim();
  if (!EMAIL.test(email)) return abgelehnt('KONTAKT_OHNE_EMAIL', true);
  if (!kontakt.lastLoginAt) return abgelehnt('KONTAKT_UNBESTAETIGT', true);
  return {
    ok: true,
    empfaenger: {
      art: 'KONTAKT',
      mandantId: mandant.id,
      mandantName: mandant.name,
      kontaktId: n.empfaengerId,
      name: kontakt.fullName,
      email,
    },
  };
}

/** Mail an den Kontakt in die Outbox (Code nur als geheime Variable). */
async function planeMailEin(
  deps: TcmsZustellDeps,
  tx: Db,
  tenantId: string,
  zeileId: string,
  n: Exclude<OffeneNachricht, { zweck: 'EREIGNIS_GEMELDET' }>,
  e: KontaktEmpfaenger,
  bis: Date,
): Promise<void> {
  const anlass = MAIL_ANLASS[n.zweck]!;
  const vorlage = TCMS_MAIL_VORLAGEN[anlass];
  const kenntnisnahme = n.daten.art === 'KENNTNISNAHME';
  const freigabe: Record<string, string> = {
    titel: n.daten.titel,
    art: TCMS_FREIGABE_ART_LABEL[n.daten.art] ?? n.daten.art,
    version: n.daten.version ?? '',
    hinweis: kenntnisnahme
      ? 'Für eine Kenntnisnahme brauchen Sie keinen Bestätigungscode.'
      : 'Den Bestätigungscode fordern Sie im Portal beim Freigeben an; er kommt mit einer eigenen E-Mail.',
  };
  let secretVars: Record<string, string> | undefined;
  if (n.zweck === 'FREIGABE_CODE') {
    freigabe['gueltigBis'] = `${berlinZeit.format(bis)} Uhr`;
    freigabe['pruefsumme'] = n.daten.sha256
      ? `Prüfsumme (SHA-256) des vorgelegten Dokuments: ${n.daten.sha256}`
      : '';
    secretVars = { code: n.daten.code };
  }
  await enqueueDirectMailTx(
    tx,
    {
      tenantId,
      clientId: e.mandantId,
      purpose: anlass,
      resource: { type: TCMS_NACHRICHT_RESSOURCE, id: zeileId },
      staffHref: `/staff/clients/${e.mandantId}/tcms`,
    },
    {
      slug: vorlage.slug,
      to: e.email,
      vars: {
        contact: { fullName: e.name },
        client: { name: e.mandantName },
        freigabe,
        link: `${deps.portalBaseUrl}/portal/tcms/freigaben`,
      },
      ...(secretVars ? { secretVars } : {}),
      fallback: { subject: vorlage.subject, bodyMd: vorlage.bodyMd },
      // Aktualitätsprüfung vor jedem Versand (outbox-relevance.ts).
      relevance: { bis: bis.toISOString(), kontaktId: e.kontaktId },
    },
  );
}

/** In-App-Hinweis an die geprüfte Kanzleiperson (Nummer und Titel, kein weiterer Inhalt). */
async function planeHinweisEin(
  deps: TcmsZustellDeps,
  tx: Db,
  tenantId: string,
  n: Extract<OffeneNachricht, { zweck: 'EREIGNIS_GEMELDET' }>,
  e: KanzleiEmpfaenger,
): Promise<void> {
  // Je Mitteilung genau ein Hinweis (die Zustellzeile ist eindeutig); anlegen
  // statt zusammenführen, damit kein zweites Ereignis den ersten Hinweis überschreibt.
  await deps.notify(
    tx,
    {
      tenantId,
      clientId: e.mandantId,
      staffId: e.staffId,
      kind: 'TCMS_EREIGNIS_GEMELDET',
      title: 'Ereignis im Tax-CMS gemeldet',
      body: `${n.daten.nummer} · ${n.daten.titel}`,
      href: `/staff/clients/${e.mandantId}/tcms/ereignisse`,
      resourceType: 'client',
      resourceId: e.mandantId,
    },
    { dedupe: 'daily' },
  );
}

/** Einmaliger Hinweis an die ADMIN/PARTNER: ohne Inhalt, ohne Code, ohne Namen. */
async function hinweisAnAdmins(
  deps: TcmsZustellDeps,
  tx: Db,
  tenantId: string,
  n: OffeneNachricht,
  grund: TcmsZustellGrund,
  mandantVorhanden: boolean,
  abgeschlossen: boolean,
): Promise<void> {
  const empfaenger = mandantVorhanden
    ? await resolveClientWarningRecipientsTx(tx, { tenantId, clientId: n.mandantId, staffIds: [] })
    : (
        await tx.staffUser.findMany({
          where: {
            tenantId,
            active: true,
            roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        })
      ).map((s) => s.id);
  if (empfaenger.length === 0) return;
  const folge = abgeschlossen
    ? 'Sie wird nicht zugestellt.'
    : `Ohne Korrektur wird sie nach ${TCMS_UNZUSTELLBAR_NACH_TAGEN} Tagen als unzustellbar abgeschlossen.`;
  const ziel = mandantVorhanden
    ? {
        clientId: n.mandantId,
        href: `/staff/clients/${n.mandantId}/tcms${n.empfaengerArt === 'KONTAKT' ? '/kontakte' : ''}`,
        resourceType: 'client',
        resourceId: n.mandantId,
      }
    : { clientId: null, href: '/staff/tcms', resourceType: 'tenant', resourceId: tenantId };
  await deps.notify(
    tx,
    empfaenger.map((staffId) => ({
      tenantId,
      staffId,
      kind: 'TCMS_ZUSTELLUNG_GESCHEITERT' as const,
      title: 'Mitteilung des Tax-CMS nicht zugestellt',
      body: `${ZWECK_LABEL[n.zweck]}: ${TCMS_ZUSTELL_GRUENDE[grund]} ${folge}`,
      ...ziel,
    })),
  );
}

/** Was nach dem Commit an das Tax-CMS geht. */
export type Meldung =
  | { art: 'ZUGESTELLT' }
  | { art: 'UNZUSTELLBAR'; grund: NachrichtUnzustellbarGrund };

export type Einplanung =
  | { art: 'eingeplant' | 'unzustellbar' | 'bereits'; zeileId: string; meldung: Meldung }
  | { art: 'zurueckgestellt' | 'konkurrenz'; meldung: null };

const zeileSelect = {
  id: true,
  status: true,
  grund: true,
  erstmalsAm: true,
  hinweisAm: true,
} satisfies Prisma.TcmsNachrichtZustellungSelect;
type Zeile = Prisma.TcmsNachrichtZustellungGetPayload<{ select: typeof zeileSelect }>;

/** Vorhandene Zustellzeile sperren: Ein paralleler Lauf wartet hier bis zum Commit. */
async function sperreZeile(tx: Db, tenantId: string, nachrichtId: string): Promise<Zeile | null> {
  const [vorhanden] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM tcms_nachricht_zustellung
     WHERE tenant_id = ${tenantId}::uuid AND nachricht_id = ${nachrichtId}
     FOR UPDATE
  `;
  return vorhanden
    ? tx.tcmsNachrichtZustellung.findUniqueOrThrow({
        where: { id: vorhanden.id },
        select: zeileSelect,
      })
    : null;
}

interface Kontext {
  deps: TcmsZustellDeps;
  tx: Db;
  tenantId: string;
  n: OffeneNachricht;
  zeile: Zeile | null;
  jetzt: Date;
}

/** Zeile aktualisieren bzw. eindeutig anlegen; `false`: ein paralleler Lauf war schneller. */
async function schreibeZeile(
  k: Kontext,
  id: string,
  daten: Parameters<typeof legeAn>[4],
): Promise<boolean> {
  if (k.zeile) {
    await k.tx.tcmsNachrichtZustellung.update({ where: { id: k.zeile.id }, data: daten });
    return true;
  }
  return legeAn(k.tx, k.tenantId, id, k.n, daten);
}

/** Empfänger bestätigt: Zeile EINGEPLANT und Mail bzw. Hinweis in derselben Transaktion. */
async function planeZustellungEin(
  k: Kontext,
  e: KontaktEmpfaenger | KanzleiEmpfaenger,
  bis: Date | null,
): Promise<Einplanung> {
  const zeileId = k.zeile?.id ?? randomUUID();
  const daten = {
    status: 'EINGEPLANT',
    grund: null,
    geprueftAm: k.jetzt,
    abgeschlossenAm: k.jetzt,
  };
  if (!(await schreibeZeile(k, zeileId, daten))) return { art: 'konkurrenz', meldung: null };
  const { n } = k;
  if (e.art === 'KONTAKT' && n.zweck !== 'EREIGNIS_GEMELDET' && bis) {
    await planeMailEin(k.deps, k.tx, k.tenantId, zeileId, n, e, bis);
  } else if (e.art === 'KANZLEI' && n.zweck === 'EREIGNIS_GEMELDET') {
    await planeHinweisEin(k.deps, k.tx, k.tenantId, n, e);
  } else {
    // Der Vertrag bindet die Empfängerart an den Zweck; sonst nichts einplanen (Rollback).
    throw new Error('tcms-nachrichten: Zweck und Empfängerart passen nicht zusammen');
  }
  return { art: 'eingeplant', zeileId, meldung: { art: 'ZUGESTELLT' } };
}

/**
 * Prüfung gescheitert: zurückstellen oder (Gültigkeitsende, N Tage) als
 * unzustellbar abschließen; einmal je Mitteilung ein Hinweis an die Admins.
 */
async function stelleZurueck(
  k: Kontext,
  grund: TcmsZustellGrund,
  mandantVorhanden: boolean,
): Promise<Einplanung> {
  const { jetzt, n } = k;
  const erstmals = k.zeile?.erstmalsAm ?? jetzt;
  const abschliessen =
    grund === 'ABGELAUFEN' ||
    jetzt.getTime() - erstmals.getTime() >= TCMS_UNZUSTELLBAR_NACH_TAGEN * TAG_MS;
  const hinweisFaellig = !k.zeile?.hinweisAm;
  const zeileId = k.zeile?.id ?? randomUUID();
  const daten = {
    status: abschliessen ? 'UNZUSTELLBAR' : 'ZURUECKGESTELLT',
    grund,
    geprueftAm: jetzt,
    abgeschlossenAm: abschliessen ? jetzt : null,
    ...(hinweisFaellig ? { hinweisAm: jetzt } : {}),
  };
  if (!(await schreibeZeile(k, zeileId, daten))) return { art: 'konkurrenz', meldung: null };
  if (hinweisFaellig) {
    await hinweisAnAdmins(k.deps, k.tx, k.tenantId, n, grund, mandantVorhanden, abschliessen);
  }
  k.deps.log.info(
    { tenantId: k.tenantId, nachrichtId: n.id, zweck: n.zweck, grund, abgeschlossen: abschliessen },
    'tcms-nachrichten: Mitteilung nicht zugestellt',
  );
  return abschliessen
    ? { art: 'unzustellbar', zeileId, meldung: { art: 'UNZUSTELLBAR', grund: meldegrund(grund) } }
    : { art: 'zurueckgestellt', meldung: null };
}

/**
 * Prüfen und einplanen in EINER Tenant-Transaktion (siehe Kopf). Exportiert
 * für den Nachweis, dass zwei gleichzeitige Einplanungen derselben Mitteilung
 * genau einen Auftrag ergeben – auch ohne den Lease des Laufs.
 */
export async function planeTcmsNachrichtEin(
  deps: TcmsZustellDeps,
  tenantId: string,
  n: OffeneNachricht,
  jetzt: Date,
): Promise<Einplanung> {
  return deps.runAtomic(tenantId, async (tx): Promise<Einplanung> => {
    const zeile = await sperreZeile(tx, tenantId, n.id);
    if (zeile && zeile.status !== 'ZURUECKGESTELLT') {
      // Abgeschlossen: dieselbe Meldung wie beim ersten Mal (Grund aus der Zeile).
      return {
        art: 'bereits',
        zeileId: zeile.id,
        meldung:
          zeile.status === 'UNZUSTELLBAR'
            ? { art: 'UNZUSTELLBAR', grund: meldegrund(zeile.grund) }
            : { art: 'ZUGESTELLT' },
      };
    }
    const k: Kontext = { deps, tx, tenantId, n, zeile, jetzt };
    const bis = gueltigBis(n);
    if (bis !== null && jetzt.getTime() >= bis.getTime()) {
      // Für den Hinweis: Mandant vorhanden (Link in die Mandantenakte)?
      const mandant = await tx.client.count({ where: { id: n.mandantId, tenantId } });
      return stelleZurueck(k, 'ABGELAUFEN', mandant > 0);
    }
    const pruefung = await pruefeEmpfaenger(tx, tenantId, n);
    return pruefung.ok
      ? planeZustellungEin(k, pruefung.empfaenger, bis)
      : stelleZurueck(k, pruefung.grund, pruefung.mandantVorhanden);
  });
}

/**
 * Legt die Zustellzeile eindeutig an. `false`: Ein paralleler Lauf hat sie
 * (inzwischen committet) angelegt – er plant ein, dieser nicht.
 */
async function legeAn(
  tx: Db,
  tenantId: string,
  id: string,
  n: OffeneNachricht,
  daten: {
    status: string;
    grund: string | null;
    geprueftAm: Date;
    abgeschlossenAm: Date | null;
    hinweisAm?: Date;
  },
): Promise<boolean> {
  const angelegt = await tx.$executeRaw`
    INSERT INTO tcms_nachricht_zustellung
      (id, tenant_id, nachricht_id, zweck, status, grund, erstmals_am, geprueft_am,
       abgeschlossen_am, hinweis_am)
    VALUES (
      ${id}::uuid, ${tenantId}::uuid, ${n.id}, ${n.zweck}, ${daten.status}, ${daten.grund},
      ${daten.geprueftAm}, ${daten.geprueftAm}, ${daten.abgeschlossenAm}, ${daten.hinweisAm ?? null}
    )
    ON CONFLICT (tenant_id, nachricht_id) DO NOTHING
  `;
  return angelegt === 1;
}

/**
 * Nach dem Commit: Zustellung bzw. Unzustellbarkeit melden. 404 (unbekannt
 * oder fremd) und 409 (im Tax-CMS bereits abgeschlossen: zugestellt bzw.
 * unzustellbar, auch mit anderem Grund) = erledigt; sonst nächster Lauf.
 */
async function melde(
  deps: TcmsZustellDeps,
  postausgang: TcmsPostausgang,
  akteur: TcmsAkteurAngaben,
  tenantId: string,
  zeileId: string,
  nachrichtId: string,
  meldung: Meldung,
  jetzt: Date,
): Promise<boolean> {
  let nichtVersenden = false;
  try {
    if (meldung.art === 'UNZUSTELLBAR') {
      await postausgang.unzustellbar(akteur, nachrichtId, meldung.grund);
    } else {
      await postausgang.melden(akteur, nachrichtId);
    }
  } catch (fehler) {
    if (fehler instanceof TcmsKonflikt) {
      // Ohne Inhalte: nur Art der Meldung, Status und requestId.
      deps.log.info(
        { tenantId, nachrichtId, meldung: meldung.art, ...fehlerFelder(fehler) },
        'tcms-nachrichten: Mitteilung im Tax-CMS bereits abgeschlossen',
      );
      nichtVersenden = meldung.art === 'ZUGESTELLT';
    } else if (!(fehler instanceof TcmsNichtGefunden)) {
      deps.log.warn(
        { tenantId, nachrichtId, meldung: meldung.art, ...fehlerFelder(fehler) },
        'tcms-nachrichten: Zustellung nicht gemeldet, nächster Lauf',
      );
      return false;
    }
  }
  await deps.runAtomic(tenantId, async (tx) => {
    await tx.tcmsNachrichtZustellung.updateMany({
      where: { id: zeileId, tenantId, gemeldetAm: null, abgeschlossenAm: { not: null } },
      data: { gemeldetAm: jetzt },
    });
    if (nichtVersenden) {
      // Nur wartende Aufträge (QUEUED, RETRY_PENDING); der Claim der Mail-Outbox
      // ist an den gelesenen Status gebunden und geht danach ins Leere.
      const { count } = await tx.mailOutbox.updateMany({
        where: {
          tenantId,
          resourceType: TCMS_NACHRICHT_RESSOURCE,
          resourceId: zeileId,
          status: { in: ['QUEUED', 'RETRY_PENDING'] },
        },
        data: {
          payload: {},
          secretVarsEnc: null,
          nextAttemptAt: null,
          status: 'SKIPPED',
          lastError: TCMS_NICHT_VERSENDET_VERWORFEN,
        },
      });
      if (count > 0) {
        deps.log.info(
          { tenantId, nachrichtId, auftraege: count },
          'tcms-nachrichten: Mail nicht versendet, Mitteilung im Tax-CMS abgeschlossen',
        );
      }
    }
  });
  return true;
}

/** Grund am Auftrag, wenn das Tax-CMS „zugestellt“ mit 409 beantwortet (kein Inhalt). */
export const TCMS_NICHT_VERSENDET_VERWORFEN =
  'Nicht versendet: Die Mitteilung ist im Tax-CMS bereits abgeschlossen oder verworfen.';

/** Gemeldete und lange nicht mehr gesehene Zeilen entfernen (keine Inhalte, nur Koordination). */
async function bereinige(deps: TcmsZustellDeps, tenantId: string, jetzt: Date): Promise<number> {
  const grenze = new Date(jetzt.getTime() - TCMS_ZUSTELLUNG_AUFBEWAHRUNG_TAGE * TAG_MS);
  const { count } = await deps.db.tcmsNachrichtZustellung.deleteMany({
    where: {
      tenantId,
      OR: [
        { gemeldetAm: { lt: grenze } },
        { status: 'ZURUECKGESTELLT', geprueftAm: { lt: grenze } },
      ],
    },
  });
  return count;
}

/** Ein Lauf für einen Tenant (Lease, Abruf, je Mitteilung Einplanung und Meldung). */
export async function stelleTenantZu(
  deps: TcmsZustellDeps,
  tenantId: string,
  ergebnis: TcmsZustellErgebnis,
  jetzt: () => Date = () => new Date(),
): Promise<void> {
  const postausgang = deps.postausgang();
  if (!postausgang || !(await deps.istAktiv(tenantId))) return;
  ergebnis.tenants += 1;
  const lauf = await beanspruche(deps.db, tenantId);
  if (!lauf) {
    ergebnis.gesperrt += 1;
    return;
  }
  let neueMails = false;
  let eingeplantHier = 0;
  try {
    let nachrichten: OffeneNachricht[];
    try {
      nachrichten = await postausgang.holen(lauf.akteur, TCMS_ZUSTELL_LIMIT);
    } catch (fehler) {
      ergebnis.fehler += 1;
      deps.log.warn({ tenantId, ...fehlerFelder(fehler) }, 'tcms-nachrichten: Abruf gescheitert');
      return;
    }
    ergebnis.abgerufen += nachrichten.length;
    for (const n of nachrichten) {
      if (!(await lauf.bestaetigen())) {
        deps.log.warn({ tenantId }, 'tcms-nachrichten: Lease verloren, Lauf beendet');
        break;
      }
      let einplanung: Einplanung;
      try {
        einplanung = await planeTcmsNachrichtEin(deps, tenantId, n, jetzt());
      } catch (fehler) {
        // Rollback: nichts eingeplant, nichts gemeldet; der nächste Lauf prüft erneut.
        ergebnis.fehler += 1;
        deps.log.error(
          { tenantId, nachrichtId: n.id, zweck: n.zweck, ...fehlerFelder(fehler) },
          'tcms-nachrichten: Einplanung gescheitert',
        );
        continue;
      }
      if (einplanung.art === 'eingeplant') {
        ergebnis.eingeplant += 1;
        eingeplantHier += 1;
        if (n.empfaengerArt === 'KONTAKT') neueMails = true;
      } else if (einplanung.art === 'zurueckgestellt') {
        ergebnis.zurueckgestellt += 1;
      } else if (einplanung.art === 'unzustellbar') {
        ergebnis.unzustellbar += 1;
      }
      if (!einplanung.meldung) continue;
      if (
        await melde(
          deps,
          postausgang,
          lauf.akteur,
          tenantId,
          einplanung.zeileId,
          n.id,
          einplanung.meldung,
          jetzt(),
        )
      ) {
        ergebnis.gemeldet += 1;
      } else {
        ergebnis.fehler += 1;
      }
    }
    if (nachrichten.length >= TCMS_ZUSTELL_LIMIT && eingeplantHier === 0) {
      deps.log.warn(
        { tenantId, anzahl: nachrichten.length },
        'tcms-nachrichten: voller Abruf ohne Einplanung – zurückgestellte Mitteilungen belegen den Postausgang',
      );
    }
    ergebnis.bereinigt += await bereinige(deps, tenantId, jetzt());
  } finally {
    await lauf.freigeben().catch(() => undefined);
    if (neueMails) deps.kickMail();
  }
}

/**
 * kk-tcms-s10nach (TCMS-NACHWEIS-001): Meldevorgänge einer Portal-Meldung nach
 * Ablauf des Wiederholungsfensters samt verschlüsseltem Inhalt löschen –
 * tenantübergreifend über den Owner-Client und unabhängig davon, ob das
 * Tax-CMS gerade konfiguriert ist (der Inhalt soll nie länger liegen). Die
 * Anlagen bleiben gebunden („ungeklärte Anlage“); freigegeben wird nichts.
 * Nie gesendete Vorgänge (Abbruch vor dem Senden) erst nach 24 h, damit die
 * Person sie vorher selbst auflösen kann.
 */
export async function meldevorgaengeBereinigen(
  db: Pick<Db, 'tcmsPortalReport'>,
  jetzt: Date,
): Promise<number> {
  const { count } = await db.tcmsPortalReport.deleteMany({
    where: {
      OR: [
        { sentAt: { lte: new Date(jetzt.getTime() - MELDUNG_WIEDERHOLUNG_FENSTER_MS) } },
        {
          sentAt: null,
          createdAt: { lte: new Date(jetzt.getTime() - MELDUNG_UNGESENDET_AUFBEWAHRUNG_MS) },
        },
      ],
    },
  });
  return count;
}

/** Ein Lauf über alle Tenants (Regelbetrieb) oder genau einen. */
export async function stelleTcmsNachrichtenZu(
  deps: TcmsZustellDeps,
  input: { tenantId?: string; jetzt?: () => Date } = {},
): Promise<TcmsZustellErgebnis> {
  const ergebnis = leeresErgebnis();
  try {
    // Echte Zeit wie das 24-h-Fenster des Tax-CMS (nie die Testuhr des Laufs).
    ergebnis.meldungenBereinigt = await meldevorgaengeBereinigen(deps.db, new Date());
  } catch (fehler) {
    ergebnis.fehler += 1;
    deps.log.error({ ...fehlerFelder(fehler) }, 'tcms-nachrichten: Meldevorgänge nicht bereinigt');
  }
  if (!deps.postausgang()) return ergebnis;
  const tenantIds = input.tenantId
    ? [input.tenantId]
    : (await deps.db.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
        (t) => t.id,
      );
  for (const tenantId of tenantIds) {
    try {
      await stelleTenantZu(deps, tenantId, ergebnis, input.jetzt);
    } catch (fehler) {
      ergebnis.fehler += 1;
      deps.log.error({ tenantId, ...fehlerFelder(fehler) }, 'tcms-nachrichten: Lauf gescheitert');
    }
  }
  return ergebnis;
}

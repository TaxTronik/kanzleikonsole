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
//   3. Erst nach dem Commit melden, und „zugestellt“ erst, wenn zugestellt
//      ist (kk-tcms-s11, Produktentscheidung Rey Koxha, 21.10.2026): Ein
//      Hinweis an eine Kanzleiperson ist mit der Einplanung zugestellt
//      (ANGENOMMEN). Eine Mail an einen Kontakt bleibt EINGEPLANT, bis ihr
//      Versandauftrag einen Endstatus hat: PROVIDER_ACCEPTED (der Mailserver
//      des Anbieters hat sie angenommen – mehr ist ohne Zustellbericht nicht
//      feststellbar) → ANGENOMMEN → `POST …/zugestellt`; FAILED,
//      NO_RECIPIENT, PARTIAL_FAILURE, UNKNOWN, SKIPPED (auch nach Ablauf des
//      Fensters) oder fehlender Auftrag → GESCHEITERT mit festem Grund →
//      `POST …/unzustellbar`. Unzustellbar vor jeder Einplanung bleibt
//      UNZUSTELLBAR (TCMS s6). 404 und 409 = erledigt (gemeldet_am). Ein
//      anderer Fehler lässt die Zeile ungemeldet; jeder Lauf führt offene
//      Zeilen nach (auch ohne erneuten Abruf, etwa wenn das Tax-CMS die
//      Mitteilung inzwischen verworfen hat) – nie eine zweite Einplanung,
//      nie ein anderer Grund.
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
import type { MailOutboxStatus, Prisma } from '@prisma/client';
import { PORTAL_ZUGANG_SELECT, portalZugangMangel } from '@taxtronik/db/portal-zugang';
import { canStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import {
  enqueueDirectMailTx,
  tcmsVerwerfGrund,
  type TcmsVerwerfGrund,
} from '@taxtronik/mail/outbox';
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
  // kk-tcms-s11: Versandauftrag ohne Annahme durch den Mailserver (GESCHEITERT).
  VERSAND_GESCHEITERT: 'Der Mailserver hat die Nachricht nicht angenommen.',
  VERSAND_UNKLAR: 'Der Versandversuch wurde abgebrochen; ob die Nachricht ankam, ist unklar.',
  VERSAND_VERWORFEN: 'Der Versandauftrag wurde vor dem Versand verworfen.',
  AUFTRAG_FEHLT: 'Der Versandauftrag ist nicht (mehr) vorhanden.',
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
  VERSAND_GESCHEITERT: 'SONSTIGES',
  VERSAND_UNKLAR: 'SONSTIGES',
  VERSAND_VERWORFEN: 'SONSTIGES',
  AUFTRAG_FEHLT: 'SONSTIGES',
} as const satisfies Readonly<Record<TcmsZustellGrund, NachrichtUnzustellbarGrund>>;

/**
 * kk-tcms-s11: Grund der Zeile, wenn die Mail-Outbox den Auftrag vor dem
 * Versand verworfen hat (SKIPPED; Vermerk aus outbox-relevance.ts). Wo die
 * Aktualitätsprüfung den Empfänger oder das Fenster nennt, gilt derselbe Grund
 * wie bei der Prüfung vor der Einplanung; sonst VERSAND_VERWORFEN (SONSTIGES).
 */
const VERWORFEN_GRUND = {
  ABGELAUFEN: 'ABGELAUFEN',
  EMPFAENGER_FREMD: 'KONTAKT_ANDERER_MANDANT',
  EMPFAENGER_INAKTIV: 'KONTAKT_INAKTIV',
  ADRESSE_UNBESTAETIGT: 'KONTAKT_UNBESTAETIGT',
  MANDAT_INAKTIV: 'MANDANT_INAKTIV',
  MANDANT_ANONYMISIERT: 'MANDANT_INAKTIV',
  MANDANT_FEHLT: 'MANDANT_UNBEKANNT',
  ADRESSE_GEAENDERT: 'VERSAND_VERWORFEN',
  EMPFAENGER_UNBESTIMMT: 'VERSAND_VERWORFEN',
  OHNE_ENDE: 'VERSAND_VERWORFEN',
  FREMDER_VORGANG: 'VERSAND_VERWORFEN',
} as const satisfies Readonly<Record<TcmsVerwerfGrund, TcmsZustellGrund>>;

/** Abschluss einer Zeile aus dem Stand ihres Versandauftrags; `null`: Versand läuft noch. */
export type AuftragsAbschluss =
  | { status: 'ANGENOMMEN'; grund: null }
  | { status: 'GESCHEITERT'; grund: TcmsZustellGrund };

const ABSCHLUSS_JE_STATUS = {
  QUEUED: null,
  SENDING: null,
  RETRY_PENDING: null,
  PROVIDER_ACCEPTED: 'ANGENOMMEN',
  FAILED: 'VERSAND_GESCHEITERT',
  NO_RECIPIENT: 'VERSAND_GESCHEITERT',
  PARTIAL_FAILURE: 'VERSAND_GESCHEITERT',
  UNKNOWN: 'VERSAND_UNKLAR',
  SKIPPED: 'VERWORFEN',
} as const satisfies Readonly<
  Record<MailOutboxStatus, null | 'ANGENOMMEN' | 'VERWORFEN' | TcmsZustellGrund>
>;

/**
 * kk-tcms-s11: „Zugestellt“ heißt, der Mailserver des Anbieters hat die
 * Nachricht angenommen (PROVIDER_ACCEPTED); ohne Zustellbericht ist mehr
 * nicht feststellbar. Jeder andere Endstatus – auch ein unklarer Ausgang
 * (UNKNOWN) – ist gescheitert, ebenso ein fehlender Auftrag (fail closed).
 */
export function auftragsAbschluss(
  auftrag: { status: MailOutboxStatus; lastError: string | null } | null,
): AuftragsAbschluss | null {
  if (!auftrag) return { status: 'GESCHEITERT', grund: 'AUFTRAG_FEHLT' };
  const abschluss: null | 'ANGENOMMEN' | 'VERWORFEN' | TcmsZustellGrund = Object.hasOwn(
    ABSCHLUSS_JE_STATUS,
    auftrag.status,
  )
    ? ABSCHLUSS_JE_STATUS[auftrag.status]
    : 'VERSAND_UNKLAR';
  if (abschluss === null) return null;
  if (abschluss === 'ANGENOMMEN') return { status: 'ANGENOMMEN', grund: null };
  if (abschluss === 'VERWORFEN') {
    const verworfen = tcmsVerwerfGrund(auftrag.lastError);
    return {
      status: 'GESCHEITERT',
      grund: verworfen ? VERWORFEN_GRUND[verworfen] : 'VERSAND_VERWORFEN',
    };
  }
  return { status: 'GESCHEITERT', grund: abschluss };
}

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
  /** kk-tcms-s11: Mail vom Mailserver angenommen bzw. Hinweis angelegt (ANGENOMMEN). */
  angenommen: number;
  /** kk-tcms-s11: Versandauftrag ohne Annahme beendet (GESCHEITERT). */
  gescheitert: number;
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
    angenommen: 0,
    gescheitert: 0,
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
    select: { clientId: true, fullName: true, ...PORTAL_ZUGANG_SELECT },
  });
  if (!kontakt) return abgelehnt('KONTAKT_UNBEKANNT', true);
  if (kontakt.clientId !== mandant.id) return abgelehnt('KONTAKT_ANDERER_MANDANT', true);
  // Dieselbe Regel, mit der die Web-App Anforderungen adressiert (kk-tcms-s11).
  const mangel = portalZugangMangel(kontakt);
  if (mangel) return abgelehnt(mangel, true);
  const email = kontakt.email.trim();
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

/**
 * Ergebnis der Einplanung bzw. Nachführung einer Mitteilung. `eingeplant`:
 * neu eingeplant (Mail: wartet auf ihren Versandauftrag, keine Meldung;
 * Hinweis an eine Kanzleiperson: zugestellt, Meldung ZUGESTELLT).
 * `angenommen`/`gescheitert`: Endstatus des Versandauftrags übernommen.
 * `wartet`: Versand läuft noch. `bereits`: abgeschlossen, Meldung wie beim
 * ersten Mal (Grund aus der Zeile).
 */
export type Einplanung =
  | { art: 'eingeplant'; zeileId: string; meldung: Meldung | null }
  | {
      art: 'angenommen' | 'gescheitert' | 'unzustellbar' | 'bereits';
      zeileId: string;
      meldung: Meldung;
    }
  | { art: 'wartet' | 'zurueckgestellt' | 'konkurrenz'; meldung: null };

const zeileSelect = {
  id: true,
  status: true,
  grund: true,
  erstmalsAm: true,
  hinweisAm: true,
} satisfies Prisma.TcmsNachrichtZustellungSelect;
type Zeile = Prisma.TcmsNachrichtZustellungGetPayload<{ select: typeof zeileSelect }>;

/** Vorhandene Zustellzeile sperren: Ein paralleler Lauf wartet hier bis zum Commit. */
async function sperreZeile(
  tx: Db,
  tenantId: string,
  ziel: { nachrichtId: string } | { zeileId: string },
): Promise<Zeile | null> {
  const [vorhanden] =
    'zeileId' in ziel
      ? await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id FROM tcms_nachricht_zustellung
           WHERE tenant_id = ${tenantId}::uuid AND id = ${ziel.zeileId}::uuid
           FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id FROM tcms_nachricht_zustellung
           WHERE tenant_id = ${tenantId}::uuid AND nachricht_id = ${ziel.nachrichtId}
           FOR UPDATE`;
  return vorhanden
    ? tx.tcmsNachrichtZustellung.findUniqueOrThrow({
        where: { id: vorhanden.id },
        select: zeileSelect,
      })
    : null;
}

/** Meldung einer abgeschlossenen Zeile; `null`, solange sie offen ist. */
export function meldungAus(zeile: { status: string; grund: string | null }): Meldung | null {
  switch (zeile.status) {
    case 'ANGENOMMEN':
      return { art: 'ZUGESTELLT' };
    case 'GESCHEITERT':
    case 'UNZUSTELLBAR':
      return { art: 'UNZUSTELLBAR', grund: meldegrund(zeile.grund) };
    default:
      return null;
  }
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

/**
 * Empfänger bestätigt: Mail bzw. Hinweis in derselben Transaktion wie die
 * Zeile. Eine Mail ist erst zugestellt, wenn ihr Versandauftrag angenommen ist
 * (EINGEPLANT, offen); ein In-App-Hinweis ist mit dem Commit zugestellt
 * (ANGENOMMEN).
 */
async function planeZustellungEin(
  k: Kontext,
  e: KontaktEmpfaenger | KanzleiEmpfaenger,
  bis: Date | null,
): Promise<Einplanung> {
  const zeileId = k.zeile?.id ?? randomUUID();
  const { n } = k;
  const mail = e.art === 'KONTAKT' && n.zweck !== 'EREIGNIS_GEMELDET' && bis;
  const hinweis = e.art === 'KANZLEI' && n.zweck === 'EREIGNIS_GEMELDET';
  if (!mail && !hinweis) {
    // Der Vertrag bindet die Empfängerart an den Zweck; sonst nichts einplanen.
    throw new Error('tcms-nachrichten: Zweck und Empfängerart passen nicht zusammen');
  }
  const daten = {
    status: mail ? 'EINGEPLANT' : 'ANGENOMMEN',
    grund: null,
    geprueftAm: k.jetzt,
    abgeschlossenAm: mail ? null : k.jetzt,
  };
  if (!(await schreibeZeile(k, zeileId, daten))) return { art: 'konkurrenz', meldung: null };
  if (e.art === 'KONTAKT' && n.zweck !== 'EREIGNIS_GEMELDET' && bis) {
    await planeMailEin(k.deps, k.tx, k.tenantId, zeileId, n, e, bis);
    return { art: 'eingeplant', zeileId, meldung: null };
  }
  if (e.art === 'KANZLEI' && n.zweck === 'EREIGNIS_GEMELDET') {
    await planeHinweisEin(k.deps, k.tx, k.tenantId, n, e);
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
 * kk-tcms-s11: Eine eingeplante Mail (Zeile gesperrt) übernimmt den Endstatus
 * ihres Versandauftrags (eindeutig je Zeile, mail_outbox_tcms_nachricht_key):
 * angenommen → ANGENOMMEN, sonst GESCHEITERT mit festem Grund; solange der
 * Versand läuft, bleibt sie offen. Bedingt auf EINGEPLANT: Ein Übergang
 * geschieht genau einmal.
 */
async function uebernimmAuftrag(
  deps: TcmsZustellDeps,
  tx: Db,
  tenantId: string,
  zeile: Zeile,
  nachrichtId: string,
  jetzt: Date,
): Promise<Einplanung> {
  const auftrag = await tx.mailOutbox.findFirst({
    where: { tenantId, resourceType: TCMS_NACHRICHT_RESSOURCE, resourceId: zeile.id },
    select: { status: true, lastError: true },
  });
  const abschluss = auftragsAbschluss(auftrag);
  if (!abschluss) return { art: 'wartet', meldung: null };
  const { count } = await tx.tcmsNachrichtZustellung.updateMany({
    where: { id: zeile.id, tenantId, status: 'EINGEPLANT' },
    data: {
      status: abschluss.status,
      grund: abschluss.grund,
      geprueftAm: jetzt,
      abgeschlossenAm: jetzt,
    },
  });
  if (count !== 1) return { art: 'konkurrenz', meldung: null };
  if (abschluss.status === 'GESCHEITERT') {
    deps.log.info(
      { tenantId, nachrichtId, grund: abschluss.grund, auftrag: auftrag?.status ?? null },
      'tcms-nachrichten: Versand nicht angenommen',
    );
  }
  const meldung = meldungAus(abschluss)!;
  return abschluss.status === 'ANGENOMMEN'
    ? { art: 'angenommen', zeileId: zeile.id, meldung }
    : { art: 'gescheitert', zeileId: zeile.id, meldung };
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
    const zeile = await sperreZeile(tx, tenantId, { nachrichtId: n.id });
    if (zeile?.status === 'EINGEPLANT') {
      return uebernimmAuftrag(deps, tx, tenantId, zeile, n.id, jetzt);
    }
    if (zeile && zeile.status !== 'ZURUECKGESTELLT') {
      // Abgeschlossen: dieselbe Meldung wie beim ersten Mal (Grund aus der Zeile).
      const meldung = meldungAus(zeile);
      if (!meldung) throw new Error('tcms-nachrichten: unbekannter Status der Zustellzeile');
      return { art: 'bereits', zeileId: zeile.id, meldung };
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
 * kk-tcms-s11: Eine Zeile ohne die Mitteilung nachführen (gesperrt): eine
 * eingeplante Mail übernimmt den Endstatus ihres Auftrags; eine
 * abgeschlossene, noch nicht gemeldete liefert ihre Meldung. So meldet der
 * Worker auch Mitteilungen, die der Abruf nicht mehr liefert (im Tax-CMS
 * inzwischen verworfen, nach dem Ausliefern weiter meldbar) oder die hinter
 * dem Limit liegen.
 */
export async function fuehreZustellungNach(
  deps: TcmsZustellDeps,
  tenantId: string,
  ziel: { zeileId: string; nachrichtId: string },
  jetzt: Date,
): Promise<Einplanung> {
  return deps.runAtomic(tenantId, async (tx): Promise<Einplanung> => {
    const zeile = await sperreZeile(tx, tenantId, { zeileId: ziel.zeileId });
    if (!zeile) return { art: 'konkurrenz', meldung: null };
    if (zeile.status === 'EINGEPLANT') {
      return uebernimmAuftrag(deps, tx, tenantId, zeile, ziel.nachrichtId, jetzt);
    }
    const meldung = meldungAus(zeile);
    return meldung
      ? { art: 'bereits', zeileId: zeile.id, meldung }
      : { art: 'zurueckgestellt', meldung: null };
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
 * unzustellbar, auch mit anderem Grund, oder verworfen, bevor ausgeliefert)
 * = erledigt; sonst nächster Lauf. Gemeldet wird „zugestellt“ erst nach der
 * Annahme durch den Mailserver (kk-tcms-s11); ein Versandauftrag wartet zu
 * diesem Zeitpunkt nie mehr.
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
    } else if (!(fehler instanceof TcmsNichtGefunden)) {
      deps.log.warn(
        { tenantId, nachrichtId, meldung: meldung.art, ...fehlerFelder(fehler) },
        'tcms-nachrichten: Zustellung nicht gemeldet, nächster Lauf',
      );
      return false;
    }
  }
  await deps.runAtomic(tenantId, (tx) =>
    tx.tcmsNachrichtZustellung.updateMany({
      where: { id: zeileId, tenantId, gemeldetAm: null, abgeschlossenAm: { not: null } },
      data: { gemeldetAm: jetzt },
    }),
  );
  return true;
}

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

/** Zähler des Laufs nach einer Einplanung bzw. Nachführung. */
function zaehle(ergebnis: TcmsZustellErgebnis, e: Einplanung): void {
  if (e.art === 'eingeplant') {
    ergebnis.eingeplant += 1;
    if (e.meldung) ergebnis.angenommen += 1;
  } else if (e.art === 'angenommen') {
    ergebnis.angenommen += 1;
  } else if (e.art === 'gescheitert') {
    ergebnis.gescheitert += 1;
  } else if (e.art === 'zurueckgestellt') {
    ergebnis.zurueckgestellt += 1;
  } else if (e.art === 'unzustellbar') {
    ergebnis.unzustellbar += 1;
  }
}

/** Gemeinsamer Zustand eines Laufs für einen Tenant. */
interface TenantLauf {
  deps: TcmsZustellDeps;
  tenantId: string;
  postausgang: TcmsPostausgang;
  lauf: NonNullable<Awaited<ReturnType<typeof beanspruche>>>;
  ergebnis: TcmsZustellErgebnis;
  jetzt: () => Date;
}

/** Meldet nach dem Commit und zählt das Ergebnis. */
async function meldeUndZaehle(
  t: TenantLauf,
  zeileId: string,
  nachrichtId: string,
  meldung: Meldung,
): Promise<void> {
  const ok = await melde(
    t.deps,
    t.postausgang,
    t.lauf.akteur,
    t.tenantId,
    zeileId,
    nachrichtId,
    meldung,
    t.jetzt(),
  );
  if (ok) t.ergebnis.gemeldet += 1;
  else t.ergebnis.fehler += 1;
}

/**
 * Abruf und je Mitteilung Einplanung bzw. Nachführung samt Meldung. Liefert
 * die geführten Zeilen (für die Nachführung), ob neue Mails anstehen und ob
 * der Lauf weitergeht (nicht nach gescheitertem Abruf oder verlorener Lease).
 */
async function planeAbgerufeneEin(
  t: TenantLauf,
): Promise<{ gesehen: Set<string>; neueMails: boolean; weiter: boolean }> {
  const { deps, tenantId, ergebnis } = t;
  const gesehen = new Set<string>();
  let neueMails = false;
  let nachrichten: OffeneNachricht[];
  try {
    nachrichten = await t.postausgang.holen(t.lauf.akteur, TCMS_ZUSTELL_LIMIT);
  } catch (fehler) {
    ergebnis.fehler += 1;
    deps.log.warn({ tenantId, ...fehlerFelder(fehler) }, 'tcms-nachrichten: Abruf gescheitert');
    return { gesehen, neueMails, weiter: false };
  }
  ergebnis.abgerufen += nachrichten.length;
  let fortschritt = 0;
  for (const n of nachrichten) {
    if (!(await t.lauf.bestaetigen())) {
      deps.log.warn({ tenantId }, 'tcms-nachrichten: Lease verloren, Lauf beendet');
      return { gesehen, neueMails, weiter: false };
    }
    let einplanung: Einplanung;
    try {
      einplanung = await planeTcmsNachrichtEin(deps, tenantId, n, t.jetzt());
    } catch (fehler) {
      // Rollback: nichts eingeplant, nichts gemeldet; der nächste Lauf prüft erneut.
      ergebnis.fehler += 1;
      deps.log.error(
        { tenantId, nachrichtId: n.id, zweck: n.zweck, ...fehlerFelder(fehler) },
        'tcms-nachrichten: Einplanung gescheitert',
      );
      continue;
    }
    zaehle(ergebnis, einplanung);
    if (['eingeplant', 'angenommen', 'gescheitert'].includes(einplanung.art)) fortschritt += 1;
    if (einplanung.art === 'eingeplant' && !einplanung.meldung) neueMails = true;
    if (!('zeileId' in einplanung)) continue;
    gesehen.add(einplanung.zeileId);
    if (einplanung.meldung) await meldeUndZaehle(t, einplanung.zeileId, n.id, einplanung.meldung);
  }
  if (nachrichten.length >= TCMS_ZUSTELL_LIMIT && fortschritt === 0) {
    deps.log.warn(
      { tenantId, anzahl: nachrichten.length },
      'tcms-nachrichten: voller Abruf ohne Einplanung – zurückgestellte oder noch nicht versendete Mitteilungen belegen den Postausgang',
    );
  }
  return { gesehen, neueMails, weiter: true };
}

/**
 * kk-tcms-s11: offene Zeilen ohne Abruf nachführen (Endstatus des Auftrags,
 * ausstehende Meldungen), älteste zuerst, höchstens ein Abruf-Limit je Lauf.
 * `false`, wenn die Lease verloren ging.
 */
async function fuehreOffeneNach(t: TenantLauf, gesehen: ReadonlySet<string>): Promise<boolean> {
  const { deps, tenantId, ergebnis } = t;
  const offen = await deps.runAtomic(tenantId, (tx) =>
    tx.tcmsNachrichtZustellung.findMany({
      where: {
        tenantId,
        gemeldetAm: null,
        status: { in: ['EINGEPLANT', 'ANGENOMMEN', 'GESCHEITERT', 'UNZUSTELLBAR'] },
        id: { notIn: [...gesehen] },
      },
      select: { id: true, nachrichtId: true },
      orderBy: [{ erstmalsAm: 'asc' }, { id: 'asc' }],
      take: TCMS_ZUSTELL_LIMIT,
    }),
  );
  for (const z of offen) {
    if (!(await t.lauf.bestaetigen())) {
      deps.log.warn({ tenantId }, 'tcms-nachrichten: Lease verloren, Lauf beendet');
      return false;
    }
    let nachgefuehrt: Einplanung;
    try {
      nachgefuehrt = await fuehreZustellungNach(
        deps,
        tenantId,
        { zeileId: z.id, nachrichtId: z.nachrichtId },
        t.jetzt(),
      );
    } catch (fehler) {
      ergebnis.fehler += 1;
      deps.log.error(
        { tenantId, nachrichtId: z.nachrichtId, ...fehlerFelder(fehler) },
        'tcms-nachrichten: Nachführung gescheitert',
      );
      continue;
    }
    zaehle(ergebnis, nachgefuehrt);
    if (nachgefuehrt.meldung) {
      await meldeUndZaehle(t, nachgefuehrt.zeileId, z.nachrichtId, nachgefuehrt.meldung);
    }
  }
  return true;
}

/** Ein Lauf für einen Tenant (Lease, Abruf, je Mitteilung Einplanung und Meldung, Nachführung). */
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
  const t: TenantLauf = { deps, tenantId, postausgang, lauf, ergebnis, jetzt };
  let neueMails = false;
  try {
    const abruf = await planeAbgerufeneEin(t);
    neueMails = abruf.neueMails;
    if (!abruf.weiter || !(await fuehreOffeneNach(t, abruf.gesehen))) return;
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

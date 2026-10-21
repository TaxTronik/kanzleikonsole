import 'server-only';

// =============================================================================
// Meldevorgang einer Ereignismeldung aus dem Portal (kk-tcms-s10nach, TCMS s10;
// TCMS-NACHWEIS-001). Das Tax-CMS nimmt je Person, Mandant und
// Idempotenzschlüssel innerhalb von 24 h (echte Zeit, ab der ersten Annahme)
// genau eine Meldung an und liefert bei einer Wiederholung mit gleichem
// Inhalt dasselbe Ereignis (`409 IDEMPOTENZ_ABWEICHUNG` bei anderem Inhalt;
// nach 24 h ist der Schlüssel verbraucht – eine Wiederholung legte dann ein
// zweites Ereignis an).
//
// Entscheidung (Ausgang offen → Klärung innerhalb des Fensters):
//   - Ein Absenden = ein Schlüssel (UUID, im Formular erzeugt; derselbe beim
//     erneuten Absenden desselben Formulars). `tcms_portal_report` hält je
//     Kontakt und Schlüssel den Vorgang; die Anlagen tragen den Schlüssel
//     (`tcms_document_reference.tcms_report_key`).
//   - Vor dem ersten Senden speichert der Vorgang den zur Wiederholung nötigen
//     Inhalt – exakt den gesendeten Body ohne Schlüssel, denn das Tax-CMS
//     vergleicht den SHA-256 des Inhalts samt Namen der benachrichtigten
//     Person – nur verschlüsselt (Secret-Box, an Tenant und Zeile gebunden,
//     wie `secretVars` der Mail-Outbox; CHECK auf das Format).
//   - Wiederholt wird nur mit demselben Schlüssel und Inhalt und nur durch
//     dieselbe Person (der Schlüssel gilt im Tax-CMS nur für sie): beim
//     erneuten Absenden des Formulars, beim nächsten Öffnen der Meldeseite
//     (automatisch) und über „Jetzt erneut übermitteln“.
//   - Wiederholt wird höchstens MELDUNG_WIEDERHOLUNG_FENSTER_MS (23 h) nach dem
//     ersten Senden: 24 h des Tax-CMS abzüglich einer Stunde für abweichende
//     Uhren der beiden Dienste. Danach löscht der Worker den Vorgang samt
//     Inhalt; die Anlagen bleiben gebunden („ungeklärte Anlage“ im Arbeitskorb
//     und im Ereigniseingang) – nie freigegeben, denn das Ereignis kann
//     existieren.
//   - Geklärt ist ein Vorgang durch die Annahme (Ereignis-ID an den Anlagen)
//     oder – nur beim ersten Versuch – durch eine eindeutige Ablehnung
//     (Anlagen frei). Eine Ablehnung einer WIEDERHOLUNG klärt nichts: Rechte
//     und Formprüfungen laufen im Tax-CMS vor dem Schlüssel, ein 4xx beweist
//     dann nicht, dass die erste Meldung fehlt. `IDEMPOTENZ_ABWEICHUNG` heißt,
//     dass mit diesem Schlüssel schon eine andere Meldung existiert: Vorgang
//     ungeklärt, Anlagen gebunden. Mit jeder Klärung entfällt der Inhalt
//     sofort (Zeile gelöscht).
//   - Ein Vorgang, der nie gesendet wurde (Abbruch vor dem Senden, Lease
//     abgelaufen), gibt seine Anlagen frei: Ohne Sendezeitpunkt hat der Dienst
//     die Meldung nie erhalten.
// Kein Dienstaufruf innerhalb einer Transaktion; Nebenläufigkeit über eine
// Lease je Vorgang mit Besitz (`lease_until` + `lease_token`).
//
// Nebenläufigkeit (RT3C-K-01, kk-tcms-fix4): Jeder Übergang entscheidet über
// den Zustand in der Bedingung seines schreibenden Statements (READ COMMITTED
// prüft sie unter der Zeilensperre gegen die neueste Fassung), nie über einen
// vorher gelesenen Wert:
//   - Jede Beanspruchung setzt eine neue Lease mit eigenem Token. Als gesendet
//     markieren und jede Klärung außer der Annahme verlangen das eigene Token:
//     Wer seine Lease verloren hat (abgelaufen und fremd beansprucht), ändert
//     nichts mehr und sendet nicht.
//   - Beanspruchen trägt die Klasse des Kandidaten in der Bedingung
//     (`sent_at IS NULL` bzw. gesendet im Fenster); den Inhalt einer
//     Wiederholung liefert dasselbe Statement (RETURNING).
//   - „Nie gesendet“ gibt nur frei, wenn der Vorgang in derselben Transaktion
//     bedingt mit `sent_at IS NULL` gelöscht wurde (zuerst löschen, nur bei
//     Treffer freigeben) – getrennt von „beim ersten Versuch eindeutig
//     abgelehnt“ (gesendet, eigene Lease).
//   - Annahme: zuerst genau diesen Vorgang löschen, die Ereignis-ID nur bei
//     Treffer setzen (ein späterer Vorgang desselben Schlüssels bleibt
//     unberührt).
//   - Unter einem Schlüssel mit noch offenen Anlagen eines früheren Vorgangs
//     beginnt kein neuer: Seine Freigabe „nie gesendet“ träfe sonst Anlagen
//     einer gesendeten Meldung.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import { MELDUNG_WIEDERHOLUNG_FENSTER_MS, TcmsKonflikt } from '@taxtronik/tcms-client';
import { ENDPUNKTE, PortalMeldungBodySchema } from '@taxtronik/tcms-contract';
import {
  decryptSecret,
  encryptSecret,
  SECRET_SLOTS,
  secretSlotContext,
} from '@/server/crypto/secret-box';
import { audit } from '@/server/actions/audit';
import { log } from '@/server/logger';
import type { TcmsAktionsEingabe, TcmsDienst } from '@/server/tcms/aktion';
import { tcmsLogFelder } from '@/server/tcms/zustand';

/** Body einer Meldung wie gesendet (mit Schlüssel). */
export type MeldungBody = NonNullable<
  TcmsAktionsEingabe<typeof ENDPUNKTE.portalMeldungErfassen>['body']
>;
/** Zur Wiederholung gespeicherter Inhalt: der Body ohne Schlüssel. */
export type MeldungInhalt = Omit<MeldungBody, 'idempotenzSchluessel'>;

const InhaltSchema = PortalMeldungBodySchema.omit({ idempotenzSchluessel: true });

/** Wiederholungsfenster ab dem ersten Senden: 24 h des Tax-CMS minus 1 h Uhrenabstand. */
export { MELDUNG_WIEDERHOLUNG_FENSTER_MS };
/** Lease beim Absenden (Ablage der Anlagen und erster Versuch). */
export const MELDUNG_ABSENDEN_LEASE_MS = 10 * 60_000;
/** Lease einer Wiederholung (ein Dienstaufruf mit Zeitlimit). */
export const MELDUNG_WIEDERHOLUNG_LEASE_MS = 2 * 60_000;
/** Höchstens so viele Vorgänge je Klärungsaufruf. */
export const MELDUNG_KLAERUNG_MAX = 3;

/** Person und Mandant eines Vorgangs (nur aus der Portal-Sitzung). */
export interface MeldevorgangBezug {
  tenantId: string;
  mandantId: string;
  kontaktId: string;
}

export interface Meldevorgang {
  id: string;
  schluessel: string;
  /** Token der eigenen Lease (Beanspruchung): nur sein Besitzer markiert und klärt. */
  token: string;
}

function inhaltKontext(tenantId: string, id: string) {
  return secretSlotContext(SECRET_SLOTS.tcmsPortalReportPayload, { tenantId, rowId: id });
}

function vorgangFilter(b: MeldevorgangBezug) {
  return { tenantId: b.tenantId, clientId: b.mandantId, contactId: b.kontaktId };
}

/** Lease frei: nie gesetzt bzw. freigegeben oder abgelaufen. */
function leaseFrei(jetzt: Date) {
  return { OR: [{ leaseUntil: null }, { leaseUntil: { lt: jetzt } }] };
}

/** Neue Lease mit eigenem Token (jede Beanspruchung). */
function neueLease(jetzt: Date, dauerMs: number): { leaseUntil: Date; leaseToken: string } {
  return { leaseUntil: new Date(jetzt.getTime() + dauerMs), leaseToken: randomUUID() };
}

function fensterBeginn(jetzt: Date): Date {
  return new Date(jetzt.getTime() - MELDUNG_WIEDERHOLUNG_FENSTER_MS);
}

/** Anlagen eines Vorgangs: offene Verknüpfungen mit diesem Schlüssel, ohne Ereignis-ID. */
function anlagenFilter(b: MeldevorgangBezug, schluessel: string) {
  return {
    tenantId: b.tenantId,
    clientId: b.mandantId,
    createdBy: b.kontaktId,
    tcmsSubject: 'EVENT',
    tcmsReportKey: schluessel,
    releasedAt: null,
    tcmsEventId: null,
  };
}

function imFenster(gesendet: Date, jetzt: Date): boolean {
  return gesendet.getTime() > fensterBeginn(jetzt).getTime();
}

export type Beanspruchung =
  | ({ art: 'neu' } & Meldevorgang)
  | ({ art: 'wiederholung'; inhalt: MeldungInhalt } & Meldevorgang)
  /** Ein anderer Versuch desselben Vorgangs läuft gerade (Lease). */
  | { art: 'laeuft' }
  /**
   * Fenster abgelaufen bzw. Schlüssel verbraucht (offene Anlagen eines
   * früheren Vorgangs): keine Wiederholung und kein neuer Vorgang mit diesem
   * Schlüssel.
   */
  | { art: 'abgelaufen' };

/**
 * Beginnt ein Absenden mit `schluessel` bzw. erkennt die Wiederholung
 * desselben Absendens (gleicher Schlüssel derselben Person): neu (Vorgang
 * angelegt, noch nicht gesendet, mit eigener Lease), Wiederholung (gesendet,
 * im Fenster, Lease übernommen, Inhalt entschlüsselt), läuft oder abgelaufen
 * (auch: Schlüssel mit offenen Anlagen eines früheren Vorgangs verbraucht).
 * Ein nie gesendeter Vorgang mit abgelaufener Lease wird aufgelöst
 * (Anlagen frei) und neu begonnen. Der erste Lesezugriff wählt nur den Weg;
 * entschieden wird in der Bedingung des jeweiligen Statements (RT3C-K-01).
 */
export async function meldevorgangBeanspruchen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  schluessel: string,
  jetzt: Date = new Date(),
): Promise<Beanspruchung> {
  return withTenantContext(ctx, async (tx) => {
    const vorhanden = await tx.tcmsPortalReport.findFirst({
      where: { ...vorgangFilter(b), idempotencyKey: schluessel },
      select: { id: true, sentAt: true },
    });
    if (!vorhanden) return neuBeginnenTx(tx, b, schluessel, jetzt);
    if (vorhanden.sentAt === null) {
      // Nie gesendet: nach Ablauf der Lease auflösen und neu beginnen. Zuerst
      // bedingt löschen (noch ungesendet, Lease frei), nur bei Treffer frei:
      // Markiert der bisherige Besitzer gleichzeitig, trifft das Löschen nicht.
      const { count } = await tx.tcmsPortalReport.deleteMany({
        where: { id: vorhanden.id, ...vorgangFilter(b), sentAt: null, ...leaseFrei(jetzt) },
      });
      if (count !== 1) return { art: 'laeuft' };
      await anlagenFreigebenTx(tx, ctx, b, schluessel, jetzt);
      return neuBeginnenTx(tx, b, schluessel, jetzt);
    }
    // Der Sendezeitpunkt ist unveränderlich (Guard): das Fenster aus dem Lesen gilt.
    if (!imFenster(vorhanden.sentAt, jetzt)) return { art: 'abgelaufen' };
    const lease = neueLease(jetzt, MELDUNG_WIEDERHOLUNG_LEASE_MS);
    const [beansprucht] = await tx.tcmsPortalReport.updateManyAndReturn({
      where: {
        id: vorhanden.id,
        ...vorgangFilter(b),
        sentAt: { gt: fensterBeginn(jetzt) },
        ...leaseFrei(jetzt),
      },
      data: lease,
      select: { payloadEnc: true },
    });
    if (!beansprucht?.payloadEnc) return { art: 'laeuft' };
    let inhalt: MeldungInhalt;
    try {
      inhalt = inhaltLesen(b.tenantId, vorhanden.id, beansprucht.payloadEnc);
    } catch (fehler) {
      // Nicht entschlüsselbar (Schlüsselbund ohne Re-Wrap): Lease läuft ab, die
      // Klärung versucht es erneut; nach dem Fenster räumt der Worker auf.
      log.error(
        { component: 'tcms-meldung', err: (fehler as Error)?.name ?? 'unbekannt' },
        'tcms-meldung: Inhalt des Meldevorgangs nicht lesbar',
      );
      return { art: 'laeuft' };
    }
    return { art: 'wiederholung', id: vorhanden.id, schluessel, token: lease.leaseToken, inhalt };
  });
}

/**
 * Legt einen neuen Vorgang an (noch nicht gesendet, Lease des Absendens).
 * Offene Anlagen dieses Schlüssels stammen aus einem früheren Vorgang, der
 * gesendet und danach ohne Annahme gelöscht wurde (Fenster abgelaufen,
 * IDEMPOTENZ_ABWEICHUNG): Der Schlüssel ist verbraucht, sonst gäbe die
 * Freigabe „nie gesendet“ des neuen Vorgangs auch diese Anlagen frei bzw. die
 * Annahme ordnete sie seinem Ereignis zu. Neue Anlagen mit diesem Schlüssel
 * bindet nur das Absenden eines bestehenden Vorgangs; der gleichzeitige erste
 * Versuch desselben Absendens scheitert am eindeutigen Schlüssel.
 */
async function neuBeginnenTx(
  tx: TxClient,
  b: MeldevorgangBezug,
  schluessel: string,
  jetzt: Date,
): Promise<Beanspruchung> {
  if ((await tx.tcmsDocumentReference.count({ where: anlagenFilter(b, schluessel) })) > 0) {
    return { art: 'abgelaufen' };
  }
  const id = randomUUID();
  const lease = neueLease(jetzt, MELDUNG_ABSENDEN_LEASE_MS);
  const { count } = await tx.tcmsPortalReport.createMany({
    data: [{ id, ...vorgangFilter(b), idempotencyKey: schluessel, ...lease }],
    skipDuplicates: true,
  });
  if (count !== 1) return { art: 'laeuft' };
  return { art: 'neu', id, schluessel, token: lease.leaseToken };
}

/**
 * Gespeicherter Inhalt: genau die gesendeten Werte (geprüft, nicht
 * umgeformt), damit die Wiederholung denselben Inhalt trägt.
 */
function inhaltLesen(tenantId: string, id: string, payload: string): MeldungInhalt {
  const roh: unknown = JSON.parse(decryptSecret(payload, inhaltKontext(tenantId, id)));
  InhaltSchema.parse(roh);
  return roh as MeldungInhalt;
}

/**
 * Anlagen des Schlüssels freigeben („nicht angehängt“). Nur nach einem
 * Treffer des bedingten Löschens desselben Vorgangs in derselben Transaktion.
 */
async function anlagenFreigebenTx(
  tx: TxClient,
  ctx: TenantContext,
  b: MeldevorgangBezug,
  schluessel: string,
  jetzt: Date,
): Promise<number> {
  const { count } = await tx.tcmsDocumentReference.updateMany({
    where: anlagenFilter(b, schluessel),
    data: { releasedAt: jetzt, releasedBy: ctx.actorId, releaseReason: 'NOT_ATTACHED' },
  });
  return count;
}

/**
 * Unmittelbar vor dem ersten Senden: Sendezeitpunkt und verschlüsselten
 * Inhalt festhalten (eigene Transaktion, vor dem Dienstaufruf committet) –
 * nur, solange der Vorgang ungesendet in der EIGENEN Lease ist (Token in der
 * Bedingung; RT3C-K-01, zweites Fenster). `false`: Lease verloren (abgelaufen
 * und fremd beansprucht) bzw. Vorgang aufgelöst – dann darf nicht gesendet
 * werden, denn eine Klärung kann ihn als „nie gesendet“ auflösen. Für den
 * ersten Dienstaufruf gilt danach eine neue Lease (ein Aufruf mit Zeitlimit).
 */
export async function meldevorgangGesendet(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  inhalt: MeldungInhalt,
  jetzt: Date = new Date(),
): Promise<boolean> {
  // Prüfen, aber unverändert speichern: die Wiederholung sendet dieselben Werte.
  InhaltSchema.parse(inhalt);
  const payloadEnc = encryptSecret(JSON.stringify(inhalt), inhaltKontext(b.tenantId, vorgang.id));
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsPortalReport.updateMany({
      where: { id: vorgang.id, ...vorgangFilter(b), sentAt: null, leaseToken: vorgang.token },
      data: {
        payloadEnc,
        sentAt: jetzt,
        leaseUntil: new Date(jetzt.getTime() + MELDUNG_WIEDERHOLUNG_LEASE_MS),
      },
    }),
  );
  return count === 1;
}

export type MeldevorgangAusgang =
  /** Angenommen: Vorgang samt Inhalt gelöscht, Ereignis-ID an den Anlagen (jeder Versuch). */
  | { art: 'angenommen'; ereignisId: string }
  /** Erster Versuch eindeutig abgelehnt (gesendet, eigene Lease): Vorgang gelöscht, Anlagen frei. */
  | { art: 'abgelehnt' }
  /** Nie gesendet (eigene Lease): Vorgang gelöscht, Anlagen frei. */
  | { art: 'nieGesendet' }
  /** Mit diesem Schlüssel existiert eine andere Meldung (eigene Lease): Vorgang gelöscht, Anlagen gebunden. */
  | { art: 'ungeklaert' }
  /** Ausgang weiter offen (eigene Lease): Lease frei, Versuch gezählt, Inhalt bleibt. */
  | { art: 'offen' };

/** Ergebnis einer Nachführung. */
export interface Nachfuehrung {
  /** Der Übergang hat gegriffen (sonst: Lease nicht mehr eigen bzw. Vorgang schon geklärt). */
  wirksam: boolean;
  /** Zugeordnete bzw. freigegebene Anlagen. */
  anlagen: number;
}

/**
 * Führt den Vorgang nach einem Versuch nach (eigene Transaktion). Jeder
 * Ausgang entscheidet in der Bedingung seines Statements: „offen“,
 * „ungeklärt“, „abgelehnt“ und „nie gesendet“ nur mit dem eigenen
 * Lease-Token; „nie gesendet“ nur mit `sent_at IS NULL`, „abgelehnt“ nur
 * gesendet. Freigegeben bzw. zugeordnet wird erst nach dem Treffer des
 * bedingten Löschens in derselben Transaktion.
 */
export async function meldevorgangAbschliessen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  ausgang: MeldevorgangAusgang,
  jetzt: Date = new Date(),
): Promise<Nachfuehrung> {
  return withTenantContext(ctx, async (tx) => {
    const zeile = { id: vorgang.id, ...vorgangFilter(b) };
    const eigen = { ...zeile, leaseToken: vorgang.token };
    const ohneAnlagen = (count: number): Nachfuehrung => ({ wirksam: count === 1, anlagen: 0 });
    switch (ausgang.art) {
      case 'offen': {
        const { count } = await tx.tcmsPortalReport.updateMany({
          where: eigen,
          data: {
            leaseUntil: null,
            leaseToken: null,
            attempts: { increment: 1 },
            lastAttemptAt: jetzt,
          },
        });
        return ohneAnlagen(count);
      }
      case 'ungeklaert': {
        // Mit der Klärung entfällt der Inhalt sofort; die Anlagen bleiben gebunden.
        const { count } = await tx.tcmsPortalReport.deleteMany({
          where: { ...eigen, sentAt: { not: null } },
        });
        return ohneAnlagen(count);
      }
      case 'angenommen': {
        // Das Ereignis existiert: jeder Versuch darf abschließen, aber nur
        // solange genau dieser Vorgang besteht – sonst gehören offene Anlagen
        // des Schlüssels womöglich schon einem späteren Vorgang.
        const { count } = await tx.tcmsPortalReport.deleteMany({
          where: { ...zeile, sentAt: { not: null } },
        });
        if (count !== 1) return { wirksam: false, anlagen: 0 };
        const { count: anlagen } = await tx.tcmsDocumentReference.updateMany({
          where: anlagenFilter(b, vorgang.schluessel),
          data: { tcmsEventId: ausgang.ereignisId },
        });
        return { wirksam: true, anlagen };
      }
      case 'abgelehnt':
      case 'nieGesendet': {
        const { count } = await tx.tcmsPortalReport.deleteMany({
          where: { ...eigen, sentAt: ausgang.art === 'nieGesendet' ? null : { not: null } },
        });
        if (count !== 1) return { wirksam: false, anlagen: 0 };
        return {
          wirksam: true,
          anlagen: await anlagenFreigebenTx(tx, ctx, b, vorgang.schluessel, jetzt),
        };
      }
    }
  });
}

/** true, wenn der Fehler `409 IDEMPOTENZ_ABWEICHUNG` ist. */
export function istIdempotenzAbweichung(fehler: unknown): boolean {
  return fehler instanceof TcmsKonflikt && fehler.konflikt === 'IDEMPOTENZ_ABWEICHUNG';
}

/** Body mit Schlüssel für den Dienst. */
export function meldungBody(inhalt: MeldungInhalt, schluessel: string): MeldungBody {
  return { ...inhalt, idempotenzSchluessel: schluessel };
}

// ---------------------------------------------------------------------------
// Klärung offener Vorgänge (Wiederholung durch dieselbe Person)
// ---------------------------------------------------------------------------

/** Offener Vorgang für die Anzeige im Portal (ohne Inhalt). */
export interface OffenerMeldevorgang {
  id: string;
  gesendetAm: Date | null;
  versuche: number;
  letzterVersuch: Date | null;
  anlagen: number;
  /** Jetzt wiederholbar (Lease frei, im Fenster bzw. nie gesendet). */
  faellig: boolean;
}

/** Offene Vorgänge der Person beim Mandanten (Portal-Seite), älteste zuerst. */
export async function offeneMeldevorgaengeTx(
  tx: TxClient,
  b: MeldevorgangBezug,
  jetzt: Date = new Date(),
): Promise<OffenerMeldevorgang[]> {
  const zeilen = await tx.tcmsPortalReport.findMany({
    where: vorgangFilter(b),
    select: {
      id: true,
      idempotencyKey: true,
      sentAt: true,
      leaseUntil: true,
      attempts: true,
      lastAttemptAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  const ergebnis: OffenerMeldevorgang[] = [];
  for (const z of zeilen) {
    if (z.sentAt !== null && !imFenster(z.sentAt, jetzt)) continue;
    const anlagen = await tx.tcmsDocumentReference.count({
      where: anlagenFilter(b, z.idempotencyKey),
    });
    ergebnis.push({
      id: z.id,
      gesendetAm: z.sentAt,
      versuche: z.attempts,
      letzterVersuch: z.lastAttemptAt,
      anlagen,
      faellig: z.leaseUntil === null || z.leaseUntil < jetzt,
    });
  }
  return ergebnis;
}

export interface Klaerung {
  /** Vorgangsnummern angenommener Meldungen. */
  angenommen: string[];
  /** Nie gesendete Vorgänge, deren Anlagen frei sind. */
  aufgeloest: number;
  /** Weiter offen (wird erneut versucht). */
  offen: number;
  /** Mit anderem Inhalt vorhanden: ungeklärt (Kanzlei klärt). */
  ungeklaert: number;
}

/** Von der Klärung beanspruchter Vorgang: nie gesendet bzw. gesendet mit Inhalt. */
interface FaelligerVorgang {
  vorgang: Meldevorgang;
  /** Verschlüsselter Inhalt aus der Beanspruchung; `null` = beansprucht mit `sent_at IS NULL`. */
  inhalt: string | null;
}

/**
 * Beansprucht bis zu `max` fällige Vorgänge der Person (eigene Lease), ohne
 * Dienst: gesendete im Fenster bzw. nie gesendete mit abgelaufener Lease.
 * Die Kandidatenliste wählt nur aus; die Klasse steht in der Bedingung des
 * beanspruchenden Updates (RT3C-K-01): Wurde ein als „nie gesendet“ gelesener
 * Vorgang inzwischen gesendet, trifft `sent_at IS NULL` nicht, und er wird
 * nicht beansprucht. Den Inhalt eines gesendeten liefert dasselbe Update.
 */
async function faelligeBeanspruchen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  jetzt: Date,
  max: number,
): Promise<FaelligerVorgang[]> {
  return withTenantContext(ctx, async (tx) => {
    const kandidaten = await tx.tcmsPortalReport.findMany({
      where: {
        ...vorgangFilter(b),
        AND: [
          leaseFrei(jetzt),
          { OR: [{ sentAt: { gt: fensterBeginn(jetzt) } }, { sentAt: null }] },
        ],
      },
      select: { id: true, idempotencyKey: true, sentAt: true },
      orderBy: { createdAt: 'asc' },
      take: max,
    });
    const beansprucht: FaelligerVorgang[] = [];
    for (const k of kandidaten) {
      const lease = neueLease(jetzt, MELDUNG_WIEDERHOLUNG_LEASE_MS);
      const vorgang = { id: k.id, schluessel: k.idempotencyKey, token: lease.leaseToken };
      const zeile = { id: k.id, ...vorgangFilter(b), ...leaseFrei(jetzt) };
      if (k.sentAt === null) {
        const { count } = await tx.tcmsPortalReport.updateMany({
          where: { ...zeile, sentAt: null },
          data: lease,
        });
        if (count === 1) beansprucht.push({ vorgang, inhalt: null });
        continue;
      }
      const [z] = await tx.tcmsPortalReport.updateManyAndReturn({
        where: { ...zeile, sentAt: { gt: fensterBeginn(jetzt) } },
        data: lease,
        select: { payloadEnc: true },
      });
      if (z?.payloadEnc) beansprucht.push({ vorgang, inhalt: z.payloadEnc });
    }
    return beansprucht;
  });
}

/**
 * Wiederholt einen gesendeten Vorgang mit demselben Schlüssel und Inhalt.
 * Nur die Annahme klärt; jede Ablehnung oder Störung lässt ihn offen
 * (Ausnahme: IDEMPOTENZ_ABWEICHUNG → ungeklärt). Wirft den Fehler des
 * Dienstes weiter.
 */
export async function meldevorgangWiederholen(
  dienst: TcmsDienst,
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  inhalt: MeldungInhalt,
): Promise<{ id: string; nummer: string }> {
  let r: { id: string; nummer: string };
  try {
    ({ daten: r } = await dienst.rufe(ENDPUNKTE.portalMeldungErfassen, {
      body: meldungBody(inhalt, vorgang.schluessel),
    }));
  } catch (fehler) {
    await nachfuehren(
      ctx,
      b,
      vorgang,
      istIdempotenzAbweichung(fehler) ? { art: 'ungeklaert' } : { art: 'offen' },
    );
    throw fehler;
  }
  await nachfuehren(ctx, b, vorgang, { art: 'angenommen', ereignisId: r.id });
  return r;
}

/**
 * Nachführen ohne Fehler zu werfen (der Vorgang bleibt sonst offen und wird
 * erneut versucht). Liefert, ob der Übergang gegriffen hat.
 */
export async function nachfuehren(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  ausgang: MeldevorgangAusgang,
): Promise<boolean> {
  try {
    const { wirksam, anlagen } = await meldevorgangAbschliessen(ctx, b, vorgang, ausgang);
    if (wirksam) {
      log.info(
        { component: 'tcms-meldung', ausgang: ausgang.art, anlagen },
        'tcms-meldung: Meldevorgang nachgeführt',
      );
    } else {
      log.warn(
        { component: 'tcms-meldung', ausgang: ausgang.art },
        'tcms-meldung: Meldevorgang nicht nachgeführt (Lease nicht mehr eigen bzw. schon geklärt)',
      );
    }
    return wirksam;
  } catch (fehler) {
    log.error(
      {
        component: 'tcms-meldung',
        ausgang: ausgang.art,
        err: (fehler as Error)?.name ?? 'unbekannt',
      },
      'tcms-meldung: Meldevorgang nicht nachgeführt (bleibt offen)',
    );
    return false;
  }
}

/**
 * Klärt bis zu MELDUNG_KLAERUNG_MAX fällige Vorgänge der Person: nie gesendete
 * auflösen (Anlagen frei), gesendete mit demselben Schlüssel und Inhalt
 * wiederholen. Wirft nie wegen des Dienstes.
 */
export async function offeneMeldungenKlaeren(
  dienst: TcmsDienst,
  ctx: TenantContext,
  b: MeldevorgangBezug,
  jetzt: Date = new Date(),
): Promise<Klaerung> {
  const ergebnis: Klaerung = { angenommen: [], aufgeloest: 0, offen: 0, ungeklaert: 0 };
  for (const { vorgang: v, inhalt: verschluesselt } of await faelligeBeanspruchen(
    ctx,
    b,
    jetzt,
    MELDUNG_KLAERUNG_MAX,
  )) {
    if (verschluesselt === null) {
      // Beansprucht mit sent_at IS NULL; frei nur, wenn das bedingte Löschen trifft.
      if (await nachfuehren(ctx, b, v, { art: 'nieGesendet' })) ergebnis.aufgeloest += 1;
      else ergebnis.offen += 1;
      continue;
    }
    let inhalt: MeldungInhalt;
    try {
      inhalt = inhaltLesen(b.tenantId, v.id, verschluesselt);
    } catch (fehler) {
      // Nicht entschlüsselbar (z. B. Schlüsselbund ohne Re-Wrap): offen lassen,
      // nach Ablauf des Fensters räumt der Worker auf.
      log.error(
        { component: 'tcms-meldung', err: (fehler as Error)?.name ?? 'unbekannt' },
        'tcms-meldung: Inhalt des Meldevorgangs nicht lesbar',
      );
      await nachfuehren(ctx, b, v, { art: 'offen' });
      ergebnis.offen += 1;
      continue;
    }
    try {
      const r = await meldevorgangWiederholen(dienst, ctx, b, v, inhalt);
      ergebnis.angenommen.push(r.nummer);
    } catch (fehler) {
      log.warn(
        { component: 'tcms-meldung', ...tcmsLogFelder(fehler) },
        'tcms-meldung: Wiederholung ohne Annahme',
      );
      if (istIdempotenzAbweichung(fehler)) ergebnis.ungeklaert += 1;
      else ergebnis.offen += 1;
    }
  }
  return ergebnis;
}

/** Neuer Schlüssel für ein Formular (eine Meldung = ein Absenden). */
export function neuerMeldeSchluessel(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Ungeklärte Anlagen (Kanzlei: Arbeitskorb und Ereigniseingang)
// ---------------------------------------------------------------------------

/** Anlage einer Portal-Meldung, deren Ausgang nicht mehr automatisch geklärt wird. */
export interface UngeklaerteAnlage {
  verknuepfungId: string;
  mandantId: string;
  dokumentId: string;
  /** Titel des Dokuments aus der eigenen Ablage. */
  titel: string;
  /** Gebunden seit (Ablage der Anlage). */
  seit: Date;
  /** Kontakt, der gemeldet hat (Name über tcmsNamenLesen). */
  kontaktId: string;
}

/** Höchstens so viele ungeklärte Anlagen je Abfrage (Anzeige). */
export const UNGEKLAERTE_ANLAGEN_MAX = 200;

/**
 * Offene Anlagen von Portal-Meldungen ohne Ereignis-ID, die kein laufender
 * Vorgang mehr klären kann: Vorgang gelöscht (Fenster abgelaufen,
 * IDEMPOTENZ_ABWEICHUNG) oder Altbestand ohne Schlüssel. Sie bleiben gebunden
 * (nie automatisch frei, das Ereignis kann existieren) und werden der Kanzlei
 * zur manuellen Klärung gezeigt. Nur die übergebenen Mandanten (Zugriff prüft
 * der Aufrufer über seine Seite), unter RLS des Tenants.
 */
export async function ungeklaerteMeldungsAnlagenTx(
  tx: TxClient,
  a: { tenantId: string; mandantIds: readonly string[] },
  jetzt: Date = new Date(),
): Promise<UngeklaerteAnlage[]> {
  if (a.mandantIds.length === 0) return [];
  const offen = await tx.tcmsDocumentReference.findMany({
    where: {
      tenantId: a.tenantId,
      clientId: { in: [...a.mandantIds] },
      tcmsSubject: 'EVENT',
      releasedAt: null,
      tcmsEventId: null,
    },
    select: {
      id: true,
      clientId: true,
      documentId: true,
      createdAt: true,
      createdBy: true,
      tcmsReportKey: true,
      document: { select: { title: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: UNGEKLAERTE_ANLAGEN_MAX,
  });
  const schluessel = [...new Set(offen.flatMap((r) => (r.tcmsReportKey ? [r.tcmsReportKey] : [])))];
  const laufend = schluessel.length
    ? await tx.tcmsPortalReport.findMany({
        where: {
          tenantId: a.tenantId,
          idempotencyKey: { in: schluessel },
          OR: [
            { sentAt: null },
            { sentAt: { gt: new Date(jetzt.getTime() - MELDUNG_WIEDERHOLUNG_FENSTER_MS) } },
          ],
        },
        select: { contactId: true, idempotencyKey: true },
      })
    : [];
  const wirdGeklaert = new Set(laufend.map((v) => `${v.contactId}|${v.idempotencyKey}`));
  return offen
    .filter(
      (r) => r.tcmsReportKey === null || !wirdGeklaert.has(`${r.createdBy}|${r.tcmsReportKey}`),
    )
    .map((r) => ({
      verknuepfungId: r.id,
      mandantId: r.clientId,
      dokumentId: r.documentId,
      titel: r.document.title,
      seit: r.createdAt,
      kontaktId: r.createdBy,
    }));
}

/** Offene Anlage ohne Ereignis-ID dieses Mandanten (für die manuelle Zuordnung). */
export async function ungeklaerteAnlageTx(
  tx: TxClient,
  a: { tenantId: string; mandantId: string; verknuepfungId: string },
): Promise<{ dokumentId: string; sha256: string } | null> {
  const r = await tx.tcmsDocumentReference.findFirst({
    where: {
      id: a.verknuepfungId,
      tenantId: a.tenantId,
      clientId: a.mandantId,
      tcmsSubject: 'EVENT',
      releasedAt: null,
      tcmsEventId: null,
    },
    select: { documentId: true, sha256: true },
  });
  return r ? { dokumentId: r.documentId, sha256: Buffer.from(r.sha256).toString('hex') } : null;
}

/**
 * Manuelle Klärung durch die Kanzlei: Ereignis-ID an einer ungeklärten Anlage
 * setzen – nur, nachdem das Tax-CMS für dieses Ereignis eine Anlage mit genau
 * diesem SHA-256 und dieser Dokument-ID bestätigt hat (Aufrufer). Liefert, ob
 * die Anlage zugeordnet wurde (eigene Transaktion).
 */
export async function ungeklaerteAnlageZuordnen(
  ctx: TenantContext,
  a: { tenantId: string; mandantId: string; verknuepfungId: string; ereignisId: string },
): Promise<boolean> {
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsDocumentReference.updateMany({
      where: {
        id: a.verknuepfungId,
        tenantId: a.tenantId,
        clientId: a.mandantId,
        tcmsSubject: 'EVENT',
        releasedAt: null,
        tcmsEventId: null,
      },
      data: { tcmsEventId: a.ereignisId },
    }),
  );
  return count === 1;
}

// ---------------------------------------------------------------------------
// Ungeklärte Anlage ohne Ereignis freigeben (kk-tcms-s11 Punkt 3,
// TCMS-NACHWEIS-001; Produktentscheidung Rey Koxha, 21.10.2026)
// ---------------------------------------------------------------------------

/**
 * Frühestens so lange nach dem ersten Senden ist eine Freigabe möglich:
 * Wiederholungsfenster plus Lease des Absendens. Ein Versuch beansprucht den
 * Vorgang nur im Fenster und hält die Lease höchstens so lange; danach kann
 * keine Übermittlung dieses Vorgangs mehr unterwegs sein – auch bei leicht
 * abweichenden Uhren der App-Instanzen. Bis dahin (und solange eine Lease
 * besteht oder der Vorgang nie gesendet wurde) gilt die Anlage als „in
 * Klärung“, auch wenn die Liste sie schon als ungeklärt zeigt.
 */
export const ANLAGE_FREIGABE_SPERRE_MS =
  MELDUNG_WIEDERHOLUNG_FENSTER_MS + MELDUNG_ABSENDEN_LEASE_MS;

/** Meldevorgang, der die Freigabe seiner Anlagen (noch) sperrt. */
function sperrtFreigabe(jetzt: Date) {
  return {
    OR: [
      { sentAt: null },
      { sentAt: { gt: new Date(jetzt.getTime() - ANLAGE_FREIGABE_SPERRE_MS) } },
      { leaseUntil: { gte: jetzt } },
    ],
  };
}

/** Offene Anlage ohne Ereignis-ID genau dieses Tenants und Mandanten. */
function offeneAnlage(a: { tenantId: string; mandantId: string; verknuepfungId: string }) {
  return {
    id: a.verknuepfungId,
    tenantId: a.tenantId,
    clientId: a.mandantId,
    tcmsSubject: 'EVENT',
    releasedAt: null,
    tcmsEventId: null,
  };
}

export type AnlageFreigabeStand =
  /** Ungeklärt und kein Meldevorgang kann sie noch klären: Dienst fragen. */
  | { art: 'offen'; dokumentId: string }
  /** Der Meldevorgang kann noch übermittelt werden (Fenster, Lease, nie gesendet). */
  | { art: 'inKlaerung' }
  /** Nicht (mehr) ungeklärt: zugeordnet, freigegeben, anderer Mandant oder unbekannt. */
  | { art: 'nichtOffen' };

async function freigabeStandTx(
  tx: TxClient,
  a: { tenantId: string; mandantId: string; verknuepfungId: string },
  jetzt: Date,
): Promise<AnlageFreigabeStand> {
  const r = await tx.tcmsDocumentReference.findFirst({
    where: offeneAnlage(a),
    select: { documentId: true, createdBy: true, tcmsReportKey: true },
  });
  if (!r) return { art: 'nichtOffen' };
  if (r.tcmsReportKey !== null) {
    const sperrend = await tx.tcmsPortalReport.count({
      where: {
        tenantId: a.tenantId,
        contactId: r.createdBy,
        idempotencyKey: r.tcmsReportKey,
        ...sperrtFreigabe(jetzt),
      },
    });
    if (sperrend > 0) return { art: 'inKlaerung' };
  }
  return { art: 'offen', dokumentId: r.documentId };
}

/**
 * Vorprüfung vor dem Dienstaufruf (Transaktion der Aktion): Ist die Anlage
 * ungeklärt und kann kein Meldevorgang sie mehr klären? Liefert die
 * Dokument-ID, nach der die Aktion das Tax-CMS fragt.
 */
export function anlageFreigabeStandTx(
  tx: TxClient,
  a: { tenantId: string; mandantId: string; verknuepfungId: string },
  jetzt: Date = new Date(),
): Promise<AnlageFreigabeStand> {
  return freigabeStandTx(tx, a, jetzt);
}

/** Ergebnis der Freigabe. */
export type AnlageFreigabe =
  | { art: 'freigegeben' }
  | Exclude<AnlageFreigabeStand, { art: 'offen' }>;

/**
 * Gibt eine ungeklärte Anlage frei („NOT_ATTACHED“), nachdem das Tax-CMS für
 * ihre Dokument-ID KEINE Ereignis-Anlage gemeldet hat
 * (`ereignisAnlagenJeDokumentLesen`, Aufrufer; auch verworfene Ereignisse
 * zählen). Eigene Transaktion: Stand erneut prüfen (Vorgang kann seit der
 * Vorprüfung nicht wieder sendebereit werden, s. ANLAGE_FREIGABE_SPERRE_MS),
 * dann bedingt freigeben – nur noch offen, ohne Ereignis-ID, mit genau der
 * geprüften Dokument-ID; eine gleichzeitige Zuordnung gewinnt bzw. verliert
 * über die Zeilensperre (READ COMMITTED prüft die Bedingung gegen die neueste
 * Fassung). Das Audit (Begründung, Prüfung des Dienstes) entsteht in derselben
 * Transaktion und nur bei Treffer.
 */
export async function ungeklaerteAnlageFreigeben(
  ctx: TenantContext,
  a: {
    tenantId: string;
    mandantId: string;
    verknuepfungId: string;
    dokumentId: string;
    begruendung: string;
    /** Vorgangsnummer der Antwort des Dienstes (Nachvollziehbarkeit). */
    requestId: string | null;
  },
  jetzt: Date = new Date(),
): Promise<AnlageFreigabe> {
  return withTenantContext(ctx, async (tx) => {
    const stand = await freigabeStandTx(tx, a, jetzt);
    if (stand.art !== 'offen') return stand;
    if (stand.dokumentId.toLowerCase() !== a.dokumentId.toLowerCase()) return { art: 'nichtOffen' };
    const { count } = await tx.tcmsDocumentReference.updateMany({
      where: { ...offeneAnlage(a), documentId: stand.dokumentId },
      data: { releasedAt: jetzt, releasedBy: ctx.actorId, releaseReason: 'NOT_ATTACHED' },
    });
    if (count !== 1) return { art: 'nichtOffen' };
    await audit(tx, ctx, {
      action: 'tcms.anlage.freigegeben',
      resourceType: 'tcms_document_reference',
      resourceId: a.verknuepfungId,
      after: {
        clientId: a.mandantId,
        documentId: stand.dokumentId,
        releaseReason: 'NOT_ATTACHED',
        begruendung: a.begruendung,
        tcmsPruefung: { endpunkt: 'ereignisAnlagenJeDokumentLesen', anlagen: 0 },
        tcmsRequestId: a.requestId,
      },
    });
    return { art: 'freigegeben' };
  });
}

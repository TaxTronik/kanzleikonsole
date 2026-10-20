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
// Lease je Vorgang (bedingtes Update).
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
}

function inhaltKontext(tenantId: string, id: string) {
  return secretSlotContext(SECRET_SLOTS.tcmsPortalReportPayload, { tenantId, rowId: id });
}

function vorgangFilter(b: MeldevorgangBezug) {
  return { tenantId: b.tenantId, clientId: b.mandantId, contactId: b.kontaktId };
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
  return gesendet.getTime() > jetzt.getTime() - MELDUNG_WIEDERHOLUNG_FENSTER_MS;
}

export type Beanspruchung =
  | ({ art: 'neu' } & Meldevorgang)
  | ({ art: 'wiederholung'; inhalt: MeldungInhalt } & Meldevorgang)
  /** Ein anderer Versuch desselben Vorgangs läuft gerade (Lease). */
  | { art: 'laeuft' }
  /** Fenster abgelaufen: keine Wiederholung mehr mit diesem Schlüssel. */
  | { art: 'abgelaufen' };

/**
 * Beginnt ein Absenden mit `schluessel` bzw. erkennt die Wiederholung
 * desselben Absendens (gleicher Schlüssel derselben Person): neu (Vorgang
 * angelegt, noch nicht gesendet, mit Lease), Wiederholung (gesendet, im
 * Fenster, Lease übernommen, Inhalt entschlüsselt), läuft oder abgelaufen.
 * Ein nie gesendeter Vorgang mit abgelaufener Lease wird aufgelöst
 * (Anlagen frei) und neu begonnen.
 */
export async function meldevorgangBeanspruchen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  schluessel: string,
  jetzt: Date = new Date(),
): Promise<Beanspruchung> {
  return withTenantContext(ctx, async (tx) => {
    const lease = new Date(jetzt.getTime() + MELDUNG_ABSENDEN_LEASE_MS);
    const vorhanden = await tx.tcmsPortalReport.findFirst({
      where: { ...vorgangFilter(b), idempotencyKey: schluessel },
      select: { id: true, sentAt: true, leaseUntil: true, payloadEnc: true },
    });
    if (!vorhanden) {
      const { id } = await tx.tcmsPortalReport.create({
        data: { ...vorgangFilter(b), idempotencyKey: schluessel, leaseUntil: lease },
        select: { id: true },
      });
      return { art: 'neu', id, schluessel };
    }
    const frei = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: jetzt } }] };
    if (vorhanden.sentAt === null) {
      // Nie gesendet: nach Ablauf der Lease auflösen und neu beginnen.
      const { count } = await tx.tcmsPortalReport.deleteMany({
        where: { id: vorhanden.id, sentAt: null, ...frei },
      });
      if (count !== 1) return { art: 'laeuft' };
      await nieGesendetFreigebenTx(tx, ctx, b, schluessel, jetzt);
      const { id } = await tx.tcmsPortalReport.create({
        data: { ...vorgangFilter(b), idempotencyKey: schluessel, leaseUntil: lease },
        select: { id: true },
      });
      return { art: 'neu', id, schluessel };
    }
    if (!imFenster(vorhanden.sentAt, jetzt)) return { art: 'abgelaufen' };
    const { count } = await tx.tcmsPortalReport.updateMany({
      where: { id: vorhanden.id, ...frei },
      data: { leaseUntil: new Date(jetzt.getTime() + MELDUNG_WIEDERHOLUNG_LEASE_MS) },
    });
    if (count !== 1) return { art: 'laeuft' };
    let inhalt: MeldungInhalt;
    try {
      inhalt = inhaltLesen(b.tenantId, vorhanden.id, vorhanden.payloadEnc!);
    } catch (fehler) {
      // Nicht entschlüsselbar (Schlüsselbund ohne Re-Wrap): Lease läuft ab, die
      // Klärung versucht es erneut; nach dem Fenster räumt der Worker auf.
      log.error(
        { component: 'tcms-meldung', err: (fehler as Error)?.name ?? 'unbekannt' },
        'tcms-meldung: Inhalt des Meldevorgangs nicht lesbar',
      );
      return { art: 'laeuft' };
    }
    return { art: 'wiederholung', id: vorhanden.id, schluessel, inhalt };
  });
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

/** Anlagen eines nie gesendeten Vorgangs freigeben („nicht angehängt“). */
async function nieGesendetFreigebenTx(
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
 * Inhalt festhalten (eigene Transaktion, vor dem Dienstaufruf committet).
 */
export async function meldevorgangGesendet(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  inhalt: MeldungInhalt,
  jetzt: Date = new Date(),
): Promise<void> {
  // Prüfen, aber unverändert speichern: die Wiederholung sendet dieselben Werte.
  InhaltSchema.parse(inhalt);
  const payloadEnc = encryptSecret(JSON.stringify(inhalt), inhaltKontext(b.tenantId, vorgang.id));
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsPortalReport.updateMany({
      where: { id: vorgang.id, ...vorgangFilter(b), sentAt: null },
      data: { payloadEnc, sentAt: jetzt },
    }),
  );
  if (count !== 1) throw new Error('tcms-meldung: Meldevorgang nicht mehr vorhanden');
}

export type MeldevorgangAusgang =
  /** Angenommen: Ereignis-ID an den Anlagen, Vorgang samt Inhalt gelöscht. */
  | { art: 'angenommen'; ereignisId: string }
  /** Eindeutig abgelehnt (nur erster Versuch) bzw. nie gesendet: Anlagen frei, Vorgang gelöscht. */
  | { art: 'abgelehnt' }
  /** Mit diesem Schlüssel existiert eine andere Meldung: Vorgang gelöscht, Anlagen gebunden. */
  | { art: 'ungeklaert' }
  /** Ausgang weiter offen: Lease frei, Versuch gezählt, Inhalt bleibt. */
  | { art: 'offen' };

/** Führt den Vorgang nach einem Versuch nach (eigene Transaktion). Liefert die Zahl betroffener Anlagen. */
export async function meldevorgangAbschliessen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  ausgang: MeldevorgangAusgang,
  jetzt: Date = new Date(),
): Promise<number> {
  return withTenantContext(ctx, async (tx) => {
    if (ausgang.art === 'offen') {
      await tx.tcmsPortalReport.updateMany({
        where: { id: vorgang.id, ...vorgangFilter(b) },
        data: { leaseUntil: null, attempts: { increment: 1 }, lastAttemptAt: jetzt },
      });
      return 0;
    }
    let anlagen = 0;
    if (ausgang.art === 'angenommen') {
      ({ count: anlagen } = await tx.tcmsDocumentReference.updateMany({
        where: anlagenFilter(b, vorgang.schluessel),
        data: { tcmsEventId: ausgang.ereignisId },
      }));
    } else if (ausgang.art === 'abgelehnt') {
      anlagen = await nieGesendetFreigebenTx(tx, ctx, b, vorgang.schluessel, jetzt);
    }
    // Mit der Klärung entfällt der Inhalt sofort.
    await tx.tcmsPortalReport.deleteMany({ where: { id: vorgang.id, ...vorgangFilter(b) } });
    return anlagen;
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

/**
 * Beansprucht bis zu `max` fällige Vorgänge der Person (Lease), ohne Dienst:
 * gesendete im Fenster (mit Inhalt) bzw. nie gesendete mit abgelaufener Lease.
 */
async function faelligeBeanspruchen(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  jetzt: Date,
  max: number,
): Promise<Array<Meldevorgang & { inhalt: string | null }>> {
  return withTenantContext(ctx, async (tx) => {
    const frei = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: jetzt } }] };
    const kandidaten = await tx.tcmsPortalReport.findMany({
      where: {
        ...vorgangFilter(b),
        AND: [
          frei,
          {
            OR: [
              { sentAt: { gt: new Date(jetzt.getTime() - MELDUNG_WIEDERHOLUNG_FENSTER_MS) } },
              { sentAt: null },
            ],
          },
        ],
      },
      select: { id: true, idempotencyKey: true, payloadEnc: true, sentAt: true },
      orderBy: { createdAt: 'asc' },
      take: max,
    });
    const beansprucht: Array<Meldevorgang & { inhalt: string | null }> = [];
    for (const k of kandidaten) {
      const { count } = await tx.tcmsPortalReport.updateMany({
        where: { id: k.id, ...frei },
        data: { leaseUntil: new Date(jetzt.getTime() + MELDUNG_WIEDERHOLUNG_LEASE_MS) },
      });
      if (count === 1) {
        beansprucht.push({ id: k.id, schluessel: k.idempotencyKey, inhalt: k.payloadEnc });
      }
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

/** Nachführen ohne Fehler zu werfen (der Vorgang bleibt sonst offen und wird erneut versucht). */
export async function nachfuehren(
  ctx: TenantContext,
  b: MeldevorgangBezug,
  vorgang: Meldevorgang,
  ausgang: MeldevorgangAusgang,
): Promise<void> {
  try {
    const anlagen = await meldevorgangAbschliessen(ctx, b, vorgang, ausgang);
    log.info(
      { component: 'tcms-meldung', ausgang: ausgang.art, anlagen },
      'tcms-meldung: Meldevorgang nachgeführt',
    );
  } catch (fehler) {
    log.error(
      {
        component: 'tcms-meldung',
        ausgang: ausgang.art,
        err: (fehler as Error)?.name ?? 'unbekannt',
      },
      'tcms-meldung: Meldevorgang nicht nachgeführt (bleibt offen)',
    );
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
  for (const v of await faelligeBeanspruchen(ctx, b, jetzt, MELDUNG_KLAERUNG_MAX)) {
    if (v.inhalt === null) {
      await nachfuehren(ctx, b, v, { art: 'abgelehnt' });
      ergebnis.aufgeloest += 1;
      continue;
    }
    let inhalt: MeldungInhalt;
    try {
      inhalt = inhaltLesen(b.tenantId, v.id, v.inhalt);
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

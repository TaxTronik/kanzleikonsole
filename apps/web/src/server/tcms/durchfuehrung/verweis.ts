// =============================================================================
// Nachweise einer Kontrolldurchführung ↔ Dokumente der kanzleikonsole
// (TCMS Stufe 3, Bereich C; Fachkatalog TCMS-NACHWEIS-001).
//
// Das Tax-CMS speichert zu einem Nachweis nur einen Verweis
// (`NachweisVerweisSchema`: Dokument-ID, Dateiname, MIME-Typ, Größe,
// SHA-256). Diese Datei bildet ihn ausschließlich aus der GESPEICHERTEN
// neuesten Version eines Dokuments genau dieses Mandanten – nie aus
// Formularangaben – und führt die Verknüpfung `tcms_document_reference`, die
// Löschen und neue Versionen des Dokuments sperrt, solange der Nachweis
// verweist:
//
//   anlegen   in einer Tenant-Transaktion VOR dem Dienstaufruf (Dokumentzeile
//             geteilt gesperrt; ein paralleles Soft-Delete wartet bzw. lässt
//             das Anlegen scheitern). Beim Hochladen in der Commit-Transaktion
//             des Dokuments.
//   bestätigen  nach Annahme durch den Dienst: Nachweis-ID setzen.
//   freigeben   nach eindeutiger Ablehnung („nicht angehängt“) bzw. nach
//             Entfernen im Tax-CMS („entfernt“). Bei offenem Ausgang bleibt die
//             Verknüpfung bestehen (im Zweifel schützen).
//
// Anlagen einer Ereignismeldung aus dem Portal (TCMS s7, Integration) sind im
// Tax-CMS ebenso Verweise (`AnlageVerweisSchema`: Dokument-ID, SHA-256) und
// werden genauso gebunden (`tcms_subject = 'EVENT'`):
//
//   anlegen   in der Commit-Transaktion der Ablage, bevor die Meldung den
//             Dienst erreicht (Ereignis-ID noch leer).
//   zuordnen  nach Annahme der Meldung: Ereignis-ID setzen (höchstens einmal).
//   freigeben nach eindeutiger Ablehnung der Meldung bzw. wenn die Meldung
//             den Dienst nie erreicht hat („nicht angehängt“) und nach dem
//             bestätigten Verwerfen des Ereignisses („verworfen“). Bei offenem
//             Ausgang bleibt die Verknüpfung bestehen (im Zweifel schützen).
//
// Die Sperrprüfung für Ablage und Versions-Route steht in ./sperre.ts (ohne
// schwere Importe).
// =============================================================================

import type { TenantContext, TxClient } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db/tenant-context';
import {
  DF_MAX_NACHWEIS_BYTES,
  gueltigerNachweisDateiname,
  NachweisVerweisSchema,
  type NachweisVerweisEingabe,
} from '@taxtronik/tcms-contract';
import { ActionError } from '@/server/actions/action-error';
import { isDocumentVersionReady } from '@/server/documents/delivery-readiness';
import { filenameWithExtension } from '@/server/storage/preview-mime';
import { tcmsTextBereinigen } from '@/server/tcms/zeichen';

/** Klassifikationen, die nie Nachweis werden (eigene Vernichtungs- bzw. Zugriffsregeln). */
export const NACHWEIS_AUSGESCHLOSSEN = ['GWG_EVIDENCE', 'PERSONNEL', 'STAFF_PRIVATE'] as const;

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** Das Dokument ist als Nachweis nicht verwendbar (fremd, gelöscht, ungescannt, ausgeschlossen). */
export class NachweisDokumentUnzulaessig extends ActionError {
  constructor() {
    super(
      'Dieses Dokument kann nicht als Nachweis verwendet werden. Möglich sind gescannte Dokumente dieses Mandanten ohne GwG-, Personal- oder Lohnbezug.',
    );
    this.name = 'NachweisDokumentUnzulaessig';
  }
}

export interface NachweisBezug {
  tenantId: string;
  mandantId: string;
  staffId: string;
}

/**
 * Wer eine Verknüpfung anlegt (`created_by`): die Kanzleiperson
 * (`staffId`) oder – für Anlagen einer Kontrollaufgabe aus dem Portal – der
 * Kontakt der Portal-Sitzung (`kontaktId`, Integration TCMS Stufe 3).
 */
export type NachweisVerknuepfer =
  | NachweisBezug
  | (Pick<NachweisBezug, 'tenantId' | 'mandantId'> & { kontaktId: string });

/** Filter der wählbaren Dokumente eines Mandanten (ohne Versionsprüfung). */
export function nachweisDokumentFilter(tenantId: string, mandantId: string) {
  return {
    tenantId,
    clientId: mandantId,
    deletedAt: null,
    gwgDestroyedAt: null,
    gwgOnboardingInviteId: null,
    formSubmissionId: null,
    requiresPayrollAccess: false,
    classification: { notIn: [...NACHWEIS_AUSGESCHLOSSEN] },
  };
}

/** Dateiname des Verweises aus dem Titel der Ablage (mit Endung, ohne verbotene Zeichen). */
export function nachweisDateiname(titel: string, mime: string): string {
  // Zeichenregel des Vertrags, still (Dateiname aus der Ablage; TCMS s8).
  const sauber = tcmsTextBereinigen(filenameWithExtension(titel, mime), 'DATEINAME', 255);
  return gueltigerNachweisDateiname(sauber) ? sauber : 'Nachweis';
}

/** MIME-Typ des Verweises aus dem geprüften Typ des Dokuments. */
export function nachweisMime(mime: string): string {
  const klein = mime.trim().toLowerCase();
  return klein.length <= 127 && MIME.test(klein) ? klein : 'application/octet-stream';
}

export interface NachweisQuelle {
  verweis: NachweisVerweisEingabe;
  versionId: string;
  sha256: Uint8Array;
}

/**
 * Verweis aus der gespeicherten neuesten Version eines Dokuments genau dieses
 * Mandanten. Sperrt die Dokumentzeile geteilt (Soft-Delete serialisiert).
 */
export async function nachweisQuelleTx(
  tx: TxClient,
  bezug: Pick<NachweisBezug, 'tenantId' | 'mandantId'>,
  dokumentId: string,
): Promise<NachweisQuelle> {
  const gesperrt = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT d.id
      FROM document d
     WHERE d.id = ${dokumentId}::uuid
       AND d.tenant_id = ${bezug.tenantId}::uuid
       AND d.client_id = ${bezug.mandantId}::uuid
       AND d.deleted_at IS NULL
     FOR SHARE OF d
  `;
  if (gesperrt.length !== 1) throw new NachweisDokumentUnzulaessig();
  const dokument = await tx.document.findFirst({
    where: { id: dokumentId, ...nachweisDokumentFilter(bezug.tenantId, bezug.mandantId) },
    select: {
      id: true,
      title: true,
      mimeType: true,
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: {
          id: true,
          sha256: true,
          sizeBytes: true,
          scanStatus: true,
          scanCompletedAt: true,
        },
      },
    },
  });
  const version = dokument?.versions[0];
  if (!dokument || !version || !isDocumentVersionReady(version)) {
    throw new NachweisDokumentUnzulaessig();
  }
  const groesse = Number(version.sizeBytes);
  const verweis = NachweisVerweisSchema.safeParse({
    dokumentId: dokument.id.toLowerCase(),
    dateiname: nachweisDateiname(dokument.title, dokument.mimeType),
    mime: nachweisMime(dokument.mimeType),
    groesse: groesse >= 1 && groesse <= DF_MAX_NACHWEIS_BYTES ? groesse : 0,
    sha256: Buffer.from(version.sha256).toString('hex'),
  });
  if (!verweis.success) throw new NachweisDokumentUnzulaessig();
  return { verweis: verweis.data, versionId: version.id, sha256: version.sha256 };
}

/**
 * Legt die offene Verknüpfung VOR dem Dienstaufruf an und liefert den Verweis
 * für `nachweisAnhaengen`. Der Datenbank-Trigger prüft erneut (neueste
 * saubere Version, Mandant, SHA-256).
 */
export async function nachweisVerknuepfenTx(
  tx: TxClient,
  bezug: NachweisVerknuepfer,
  dokumentId: string,
  durchfuehrungId: string,
): Promise<{ verknuepfungId: string; verweis: NachweisVerweisEingabe }> {
  const quelle = await nachweisQuelleTx(tx, bezug, dokumentId);
  const { id } = await tx.tcmsDocumentReference.create({
    data: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      documentId: quelle.verweis.dokumentId,
      documentVersionId: quelle.versionId,
      sha256: Buffer.from(quelle.sha256),
      tcmsSubject: 'EXECUTION',
      tcmsExecutionId: durchfuehrungId,
      createdBy: 'kontaktId' in bezug ? bezug.kontaktId : bezug.staffId,
    },
    select: { id: true },
  });
  return { verknuepfungId: id, verweis: quelle.verweis };
}

/** Annahme durch den Dienst: Nachweis-ID an der offenen Verknüpfung setzen (eigene Transaktion). */
export async function nachweisVerknuepfungBestaetigen(
  ctx: TenantContext,
  verknuepfungId: string,
  nachweisId: string,
): Promise<boolean> {
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsDocumentReference.updateMany({
      where: {
        id: verknuepfungId,
        tcmsSubject: 'EXECUTION',
        releasedAt: null,
        tcmsEvidenceId: null,
      },
      data: { tcmsEvidenceId: nachweisId },
    }),
  );
  return count === 1;
}

export type NachweisFreigabeGrund = 'REMOVED' | 'NOT_ATTACHED';

/**
 * Gibt offene Verknüpfungen frei (eigene Transaktion): nach eindeutiger
 * Ablehnung des Anhängens (`verknuepfungId`) bzw. nach dem Entfernen im
 * Tax-CMS (`nachweisId` einer Durchführung dieses Mandanten).
 */
export async function nachweisVerknuepfungFreigeben(
  ctx: TenantContext,
  ziel:
    | { verknuepfungId: string }
    | { mandantId: string; durchfuehrungId: string; nachweisId: string },
  grund: NachweisFreigabeGrund,
): Promise<number> {
  const filter =
    'verknuepfungId' in ziel
      ? { id: ziel.verknuepfungId }
      : {
          clientId: ziel.mandantId,
          tcmsExecutionId: ziel.durchfuehrungId,
          tcmsEvidenceId: ziel.nachweisId,
        };
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsDocumentReference.updateMany({
      where: { tenantId: ctx.tenantId, tcmsSubject: 'EXECUTION', releasedAt: null, ...filter },
      data: { releasedAt: new Date(), releasedBy: ctx.actorId, releaseReason: grund },
    }),
  );
  return count;
}

// ---------------------------------------------------------------------------
// Anlagen einer Ereignismeldung (Portal, TCMS s7)
// ---------------------------------------------------------------------------

/**
 * Bindet ein soeben abgelegtes Dokument als Anlage einer Ereignismeldung
 * (`created_by` = Kontakt der Sitzung). Aufruf in der Commit-Transaktion der
 * Ablage; Version und SHA-256 aus der gespeicherten neuesten Version, der
 * Trigger prüft erneut.
 */
export async function meldungsAnlageVerknuepfenTx(
  tx: TxClient,
  bezug: Pick<NachweisBezug, 'tenantId' | 'mandantId'> & { kontaktId: string },
  dokumentId: string,
): Promise<string> {
  const quelle = await nachweisQuelleTx(tx, bezug, dokumentId);
  const { id } = await tx.tcmsDocumentReference.create({
    data: {
      tenantId: bezug.tenantId,
      clientId: bezug.mandantId,
      documentId: quelle.verweis.dokumentId,
      documentVersionId: quelle.versionId,
      sha256: Buffer.from(quelle.sha256),
      tcmsSubject: 'EVENT',
      createdBy: bezug.kontaktId,
    },
    select: { id: true },
  });
  return id;
}

/**
 * Annahme der Meldung durch den Dienst: Ereignis-ID an den offenen
 * Verknüpfungen setzen (eigene Transaktion). Liefert die Zahl der zugeordneten.
 */
export async function meldungsAnlagenZuordnen(
  ctx: TenantContext,
  verknuepfungIds: readonly string[],
  ereignisId: string,
): Promise<number> {
  if (verknuepfungIds.length === 0) return 0;
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsDocumentReference.updateMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: [...verknuepfungIds] },
        tcmsSubject: 'EVENT',
        releasedAt: null,
        tcmsEventId: null,
      },
      data: { tcmsEventId: ereignisId },
    }),
  );
  return count;
}

/** NOT_ATTACHED: Meldung abgewiesen bzw. nie gesendet; DISCARDED: Ereignis verworfen. */
export type MeldungsAnlageFreigabeGrund = 'NOT_ATTACHED' | 'DISCARDED';

/**
 * Gibt offene Verknüpfungen von Meldungsanlagen frei (eigene Transaktion):
 * bestimmte Verknüpfungen (`verknuepfungIds`, Meldung nicht angenommen) bzw.
 * alle Anlagen eines Ereignisses dieses Mandanten (nach dem Verwerfen).
 */
export async function meldungsAnlagenFreigeben(
  ctx: TenantContext,
  ziel: { verknuepfungIds: readonly string[] } | { mandantId: string; ereignisId: string },
  grund: MeldungsAnlageFreigabeGrund,
): Promise<number> {
  if ('verknuepfungIds' in ziel && ziel.verknuepfungIds.length === 0) return 0;
  const filter =
    'verknuepfungIds' in ziel
      ? { id: { in: [...ziel.verknuepfungIds] } }
      : { clientId: ziel.mandantId, tcmsEventId: ziel.ereignisId };
  const { count } = await withTenantContext(ctx, (tx) =>
    tx.tcmsDocumentReference.updateMany({
      where: { tenantId: ctx.tenantId, tcmsSubject: 'EVENT', releasedAt: null, ...filter },
      data: { releasedAt: new Date(), releasedBy: ctx.actorId, releaseReason: grund },
    }),
  );
  return count;
}

/** Wählbares Dokument für die Auswahl „vorhandenes Dokument“ (nur Anzeige). */
export interface NachweisDokumentWahl {
  id: string;
  titel: string;
  mime: string;
  groesse: number;
  erstelltAm: string;
}

/**
 * Wählbare Dokumente dieses Mandanten (neueste Version sauber gescannt),
 * neueste zuerst, höchstens `max`. Die Aktion prüft die Auswahl erneut.
 */
export async function nachweisDokumenteTx(
  tx: TxClient,
  bezug: Pick<NachweisBezug, 'tenantId' | 'mandantId'>,
  max = 200,
): Promise<NachweisDokumentWahl[]> {
  const dokumente = await tx.document.findMany({
    where: nachweisDokumentFilter(bezug.tenantId, bezug.mandantId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: max,
    select: {
      id: true,
      title: true,
      mimeType: true,
      createdAt: true,
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: { sizeBytes: true, scanStatus: true, scanCompletedAt: true },
      },
    },
  });
  return dokumente.flatMap((d) => {
    const version = d.versions[0];
    if (!version || !isDocumentVersionReady(version)) return [];
    return [
      {
        id: d.id,
        titel: d.title,
        mime: d.mimeType,
        groesse: Number(version.sizeBytes),
        erstelltAm: d.createdAt.toISOString(),
      },
    ];
  });
}

/** Abgleich eines Nachweises mit der Ablage (nur Anzeige; die Route prüft selbst). */
export type NachweisAbgleich = 'OK' | 'ABWEICHUNG' | 'FEHLT';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abgleich je Nachweis: Dokument dieses Mandanten vorhanden (nicht gelöscht,
 * neueste Version sauber) und SHA-256/Größe gleich dem Verweis. Die Seite
 * zeigt danach Download, Abweichung oder „nicht verfügbar“.
 */
export async function nachweisAbgleichTx(
  tx: TxClient,
  bezug: Pick<NachweisBezug, 'tenantId' | 'mandantId'>,
  nachweise: ReadonlyArray<{ id: string; dokumentId: string; sha256: string; groesse: number }>,
): Promise<Map<string, NachweisAbgleich>> {
  const ids = [...new Set(nachweise.map((n) => n.dokumentId).filter((id) => UUID.test(id)))];
  const dokumente =
    ids.length === 0
      ? []
      : await tx.document.findMany({
          where: {
            id: { in: ids.map((id) => id.toLowerCase()) },
            tenantId: bezug.tenantId,
            clientId: bezug.mandantId,
            deletedAt: null,
          },
          select: {
            id: true,
            versions: {
              orderBy: { versionNo: 'desc' },
              take: 1,
              select: { sha256: true, sizeBytes: true, scanStatus: true, scanCompletedAt: true },
            },
          },
        });
  const je = new Map(dokumente.map((d) => [d.id.toLowerCase(), d.versions[0]]));
  const ergebnis = new Map<string, NachweisAbgleich>();
  for (const n of nachweise) {
    const version = UUID.test(n.dokumentId) ? je.get(n.dokumentId.toLowerCase()) : undefined;
    if (!version || !isDocumentVersionReady(version)) ergebnis.set(n.id, 'FEHLT');
    else if (
      Buffer.from(version.sha256).toString('hex') !== n.sha256.toLowerCase() ||
      Number(version.sizeBytes) !== n.groesse
    ) {
      ergebnis.set(n.id, 'ABWEICHUNG');
    } else ergebnis.set(n.id, 'OK');
  }
  return ergebnis;
}

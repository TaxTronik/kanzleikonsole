import 'server-only';

// =============================================================================
// Anlagen aus dem Mandantenportal für das Tax-CMS (TCMS Stufe 3, Bereich D;
// ADR 0001 §6 im TCMS-Repo): Dateien nimmt nur die kanzleikonsole an – über
// ihre Portal-Dokumentenpipeline –, das TCMS erhält einen Verweis.
//
// Regeln (Portal-Upload der kanzleikonsole + AnlageVerweisSchema des Vertrags):
//   - Portal-Funktion „Dokumente hochladen“ (`documentUpload`) muss an sein,
//     geprüft vor Scan/Journal/Write und erneut im Commit (K-06).
//   - Je Datei höchstens PORTAL_MAX_ANLAGE_BYTES (10 MiB), je Vorgang höchstens
//     PORTAL_MAX_ANLAGEN (5) Dateien; Prüfung in der Aktion (portalDateienFeld).
//   - Zusammen höchstens PORTAL_ANLAGEN_GESAMT_BYTES je Vorgang: Server-Actions
//     nehmen nur SERVER_ACTION_BODY_LIMIT_BYTES an (src/lib/upload-limits.mjs);
//     5 × 10 MiB passen nicht in einen Aufruf.
//   - ClamAV, SHA-256, Journal-first und Object Lock über runJournaledUpload
//     (DOC-UPLOAD-JOURNAL-001, DOC-OBJECT-LOCK-001).
//   - Dateityp nach Magic Bytes (M-2): erkannter Typ muss auf der Positivliste
//     PORTAL_ANLAGE_MIME stehen; ohne Erkennung nur Typen ohne Signatur (CSV,
//     Text, altes Excel/Word). Eine als PDF oder Bild gemeldete Datei ohne
//     passende Signatur wird abgewiesen – vor Journal und Object-Write.
//   - Dokument am Sitzungsmandanten, vom Kontakt selbst hochgeladen und deshalb
//     wie jeder Portal-Upload für den Mandanten freigegeben (DOC-PORTAL-SHARING-001).
//   - Der Verweis entsteht aus der GESPEICHERTEN Fassung (Dokument-ID,
//     erkannter Typ, Größe und SHA-256 des Commits), nie aus Formularangaben.
//   - Anlagen einer Kontrollaufgabe sind Nachweise einer Durchführung
//     (TCMS-NACHWEIS-001): `portalNachweisAblegen` verknüpft das Dokument in
//     DERSELBEN Commit-Transaktion über `nachweisVerknuepfenTx` (Bereich C) –
//     danach sind Löschen und neue Versionen gesperrt, bis der Nachweis im
//     Tax-CMS entfernt ist. Anlagen einer Ereignismeldung (`portalAnlageAblegen`,
//     TCMS s7) verweisen im Tax-CMS ebenso über Dokument-ID und SHA-256 und
//     werden in derselben Commit-Transaktion gebunden
//     (`meldungsAnlageVerknuepfenTx`, Bezug „Ereignis“); die Ereignis-ID folgt
//     nach Annahme der Meldung (server/tcms/portal/meldung.ts).
//   - Nach dem Commit dasselbe n8n-Ereignis wie jeder Portal-Upload
//     (`document.uploaded`, Quelle `tcms-nachweis` bzw. `tcms-meldung`, ohne
//     Dateiname und Angaben des Tax-CMS; server/tcms/hochgeladen.ts).
// =============================================================================

import { createHash } from 'node:crypto';
import {
  PORTAL_ANLAGE_MIME,
  PORTAL_MAX_ANLAGE_BYTES,
  PORTAL_MAX_ANLAGEN,
} from '@taxtronik/tcms-contract';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { z } from 'zod';
import {
  SERVER_ACTION_BODY_LIMIT_BYTES,
  UPLOAD_ACTION_OVERHEAD_BYTES,
} from '@/lib/upload-limits.mjs';
import { ActionError } from '@/server/actions/action-error';
import { audit } from '@/server/actions/audit';
import { runJournaledUpload, uploadFailureCause } from '@/server/documents/journaled-upload';
import { createDocumentWithVersion } from '@/server/documents/upload-helpers';
import { checkPortalWriteLimit } from '@/server/rate-limit';
import {
  PortalFeatureDisabledError,
  readPortalFeaturesTx,
} from '@/server/settings/portal-features';
import {
  meldungsAnlageVerknuepfenTx,
  nachweisVerknuepfenTx,
} from '@/server/tcms/durchfuehrung/verweis';
import { tcmsTextBereinigen } from '@/server/tcms/zeichen';
import { tcmsDokumentHochgeladen, type TcmsUploadQuelle } from '@/server/tcms/hochgeladen';
import type { NachweisVerknuepft } from '@/server/tcms/durchfuehrung/nachweis-aktion';

export { PORTAL_MAX_ANLAGE_BYTES, PORTAL_MAX_ANLAGEN };

/** Alle Dateien eines Aufrufs zusammen (Body-Limit der Server-Actions ohne Overhead). */
export const PORTAL_ANLAGEN_GESAMT_BYTES =
  SERVER_ACTION_BODY_LIMIT_BYTES - UPLOAD_ACTION_OVERHEAD_BYTES;

/** Herkunft im Upload-Journal. */
export const PORTAL_ANLAGE_QUELLE = 'portal.tcms.anlage';

/** Verweis auf eine angenommene Anlage (NachweisVerweis- und AnlageVerweis-tauglich). */
export interface TcmsAnlageVerweis {
  dokumentId: string;
  dateiname: string;
  mime: string;
  groesse: number;
  sha256: string;
}

/** Kontext der Portal-Aktion (Teil von PortalCtx). */
export interface PortalAblageKontext {
  ctx: TenantContext;
  tenantId: string;
  contactId: string;
  clientId: string;
}

/** Fachliche Ablehnung mit fester, UI-tauglicher Meldung. */
export class TcmsAnlageAbgelehnt extends ActionError {
  constructor(readonly grund: 'TYP' | 'GROESSE' | 'LEER' | 'ANZAHL') {
    super(
      grund === 'TYP'
        ? 'Dieser Dateityp wird nicht angenommen (PDF, Bild, CSV, Text, Excel, Word oder ZIP).'
        : grund === 'GROESSE'
          ? 'Eine Datei ist größer als 10 MB.'
          : grund === 'LEER'
            ? 'Eine Datei ist leer.'
            : `Bitte höchstens ${PORTAL_MAX_ANLAGEN} Dateien auf einmal hochladen.`,
    );
    this.name = 'TcmsAnlageAbgelehnt';
  }
}

/** Typen ohne Magic-Byte-Signatur: nur dann darf die Angabe des Browsers gelten. */
const OHNE_SIGNATUR = new Set([
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/msword',
]);

/**
 * Wirksamer Dateityp einer Portal-Anlage oder null (abweisen). `erkannt`: Typ
 * nach Magic Bytes (Storage, M-2); `gemeldet`: Angabe des Browsers.
 */
export function effektiverPortalMime(erkannt: string | null, gemeldet: string): string | null {
  if (erkannt !== null) {
    const typ = erkannt.toLowerCase();
    return PORTAL_ANLAGE_MIME.test(typ) ? typ : null;
  }
  const angabe = gemeldet.split(';')[0]!.trim().toLowerCase();
  return OHNE_SIGNATUR.has(angabe) && PORTAL_ANLAGE_MIME.test(angabe) ? angabe : null;
}

/** Anführungszeichen zusätzlich zur Regel des Vertrags (Content-Disposition beim Abruf). */
const ANFUEHRUNGSZEICHEN = /"/g;

/**
 * Anzeigename einer hochgeladenen Datei: nur der Dateiname (ohne Pfad), mit
 * der Zeichenregel des Vertrags still bereinigt (server/tcms/zeichen.ts, TCMS
 * s8), höchstens 200 Zeichen.
 */
export function portalDateiname(roh: string): string {
  const basis = roh.split(/[\\/]/).pop() ?? '';
  const sauber = tcmsTextBereinigen(basis.replace(ANFUEHRUNGSZEICHEN, ''), 'DATEINAME', 200);
  return sauber === '' || sauber === '.' || sauber === '..' ? 'Anlage' : sauber;
}

/**
 * Kontext für die Ablage aus dem Gate der Portal-Aktion, nach dem Schreib-Limit
 * des Portals (S4: jeder schreibende Portal-Pfad, Uploads sättigen sonst Storage
 * und ClamAV).
 */
export async function portalAblageKontext(g: PortalAblageKontext): Promise<PortalAblageKontext> {
  const limit = await checkPortalWriteLimit(g.contactId);
  if (!limit.ok) {
    throw new ActionError(
      `Zu viele Aktionen. Bitte ${Math.ceil(limit.retryAfter / 60)} Min. warten.`,
    );
  }
  return { ctx: g.ctx, tenantId: g.tenantId, contactId: g.contactId, clientId: g.clientId };
}

/** SHA-256 (hex) des Inhalts einer ausgewählten Datei (Dubletten vor dem Ablegen erkennen). */
export async function dateiSha256(datei: File): Promise<string> {
  return createHash('sha256')
    .update(Buffer.from(await datei.arrayBuffer()))
    .digest('hex');
}

/**
 * Formularfeld mit Dateien einer Portal-Aktion: Anzahl, Leere, Größe je Datei
 * und zusammen. Ohne Auswahl senden Browser ein leeres Dateifeld (entfernt).
 */
export function portalDateienFeld(optionen: { pflicht: boolean }) {
  return z
    .array(z.instanceof(File))
    .default([])
    .transform((liste) => liste.filter((d) => d.size > 0 || d.name !== ''))
    .refine(
      (liste) => !optionen.pflicht || liste.length > 0,
      'Bitte mindestens eine Datei auswählen.',
    )
    .refine(
      (liste) => liste.length <= PORTAL_MAX_ANLAGEN,
      `Bitte höchstens ${PORTAL_MAX_ANLAGEN} Dateien auf einmal hochladen.`,
    )
    .refine((liste) => liste.every((d) => d.size > 0), 'Eine Datei ist leer.')
    .refine(
      (liste) => liste.every((d) => d.size <= PORTAL_MAX_ANLAGE_BYTES),
      'Eine Datei ist größer als 10 MB.',
    )
    .refine(
      (liste) => liste.reduce((summe, d) => summe + d.size, 0) <= PORTAL_ANLAGEN_GESAMT_BYTES,
      'Die Dateien sind zusammen zu groß für einen Vorgang.',
    );
}

/** Größe und Leere vor dem Lesen der Bytes (die Anzahl prüft die Aktion). */
export function pruefePortalDatei(datei: File): void {
  if (datei.size === 0) throw new TcmsAnlageAbgelehnt('LEER');
  if (datei.size > PORTAL_MAX_ANLAGE_BYTES) throw new TcmsAnlageAbgelehnt('GROESSE');
}

/** Abgelegte Anlage einer Ereignismeldung: Verweis und offene Verknüpfung. */
export interface MeldungsAnlageAbgelegt {
  verweis: TcmsAnlageVerweis;
  verknuepfungId: string;
}

/**
 * Legt eine Portal-Anlage einer Ereignismeldung als Dokument des
 * Sitzungsmandanten ab und bindet es in derselben Commit-Transaktion
 * (TCMS-NACHWEIS-001, Bezug „Ereignis“, `created_by` = Kontakt der Sitzung,
 * `schluessel` = Idempotenzschlüssel des Meldevorgangs, kk-tcms-s10nach).
 * Liefert den Verweis aus der gespeicherten Fassung samt offener Verknüpfung.
 * Fehler kommen als UI-taugliche Ursache (ActionError, UploadRejectedError)
 * beim zentralen Fehler-Mapping an.
 */
export function portalAnlageAblegen(
  g: PortalAblageKontext,
  datei: File,
  schluessel: string | null = null,
): Promise<MeldungsAnlageAbgelegt> {
  return ablegen(g, datei, 'tcms-meldung', async (tx, verweis) => ({
    verweis,
    verknuepfungId: await meldungsAnlageVerknuepfenTx(
      tx,
      { tenantId: g.tenantId, mandantId: g.clientId, kontaktId: g.contactId },
      verweis.dokumentId,
      schluessel,
    ),
  }));
}

/**
 * Wie `portalAnlageAblegen`, für Anlagen einer Kontrollaufgabe: verknüpft das
 * Dokument in derselben Commit-Transaktion mit der Durchführung
 * (TCMS-NACHWEIS-001, `created_by` = Kontakt der Sitzung) und liefert den
 * Verweis aus der gespeicherten Version samt offener Verknüpfung. Das Anhängen
 * im Tax-CMS und die Nachführung der Verknüpfung übernimmt
 * `nachweisAnhaengenUndBinden` (Bereich C).
 */
export function portalNachweisAblegen(
  g: PortalAblageKontext,
  datei: File,
  durchfuehrungId: string,
): Promise<NachweisVerknuepft> {
  return ablegen(g, datei, 'tcms-nachweis', (tx, verweis) =>
    nachweisVerknuepfenTx(
      tx,
      { tenantId: g.tenantId, mandantId: g.clientId, kontaktId: g.contactId },
      verweis.dokumentId,
      durchfuehrungId,
    ),
  );
}

async function ablegen<T>(
  g: PortalAblageKontext,
  datei: File,
  quelle: TcmsUploadQuelle,
  imCommit: (tx: TxClient, verweis: TcmsAnlageVerweis) => Promise<T>,
): Promise<T> {
  pruefePortalDatei(datei);
  const dateiname = portalDateiname(datei.name);
  const gemeldet = datei.type;
  let abgelegt: { wert: T; dokumentId: string };
  try {
    const { result } = await runJournaledUpload({
      context: g.ctx,
      source: PORTAL_ANLAGE_QUELLE,
      check: async (tx) => {
        const funktionen = await readPortalFeaturesTx(tx, g.tenantId);
        if (!funktionen.documentUpload) throw new PortalFeatureDisabledError('documentUpload');
        return null;
      },
      readBytes: async () => Buffer.from(await datei.arrayBuffer()),
      storage: () => ({ tier: 'NONE', classification: 'GENERAL' }),
      afterPrepare: ({ prepared }) => {
        if (prepared.sizeBytes > BigInt(PORTAL_MAX_ANLAGE_BYTES)) {
          throw new TcmsAnlageAbgelehnt('GROESSE');
        }
        if (effektiverPortalMime(prepared.detectedMime, gemeldet) === null) {
          throw new TcmsAnlageAbgelehnt('TYP');
        }
      },
      commitTx: async (tx, { commit }) => {
        const mime = effektiverPortalMime(commit.detectedMime, gemeldet);
        if (mime === null) throw new TcmsAnlageAbgelehnt('TYP');
        const sha256 = Buffer.from(commit.sha256).toString('hex');
        const { document } = await createDocumentWithVersion(tx, {
          documentData: {
            tenantId: g.tenantId,
            clientId: g.clientId,
            ownerStaffId: null,
            title: dateiname,
            classification: 'GENERAL',
            mimeType: mime,
            retentionUntil: commit.retentionUntil,
            // Vom Mandanten selbst hochgeladen: wie jeder Portal-Upload geteilt.
            sharedWithClientAt: new Date(),
          },
          commit,
          createdById: g.contactId,
        });
        await audit(tx, g, {
          action: 'document.upload',
          resourceType: 'document',
          resourceId: document.id,
          after: {
            title: dateiname,
            classification: 'GENERAL',
            clientId: g.clientId,
            sha256,
            source: 'portal.tcms',
          },
        });
        const wert = await imCommit(tx, {
          dokumentId: document.id,
          dateiname,
          mime,
          groesse: Number(commit.sizeBytes),
          sha256,
        });
        return { wert, dokumentId: document.id };
      },
    });
    abgelegt = result;
  } catch (fehler) {
    // Ursache statt Phasen-Hülle: ActionError mit Text, Virenscan/Größe über toActionError.
    throw uploadFailureCause(fehler);
  }
  // kk-tcms-s11: dasselbe n8n-Ereignis wie jeder Portal-Upload, nach dem Commit.
  await tcmsDokumentHochgeladen({
    tenantId: g.tenantId,
    mandantId: g.clientId,
    dokumentId: abgelegt.dokumentId,
    classification: 'GENERAL',
    quelle,
  });
  return abgelegt.wert;
}

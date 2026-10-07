// =============================================================================
// DATEV-Belege-Export — ZIP für einen Mandanten
//
// Streamt alle GoBD-Belege (Rechnungen, Verträge, Steuer-Belege) als ZIP mit
// (in dieser Reihenfolge, P-03):
//   - belege/<lfd-nr>_<title>.<ext>     (Original-Dateien)
//   - index.csv                          (DATEV-kompatible Begleitliste)
//   - manifest.txt                       (Lesbare Zusammenfassung)
//
// Optional Datumsbereich via Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
// (filtert nach Document.createdAt)
//
// Ein Audit-Eintrag pro Export-Vorgang (Compliance: wer hat wann was
// exportiert): `client.belege.export` mit Anzahl und allen Dokument-IDs in
// Archivreihenfolge, wie `document.download.bulk` beim Sammeldownload.
// =============================================================================
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { MAX_UPLOAD_BYTES, streamObject, type ObjectStream } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import {
  acquireZipStreamSlot,
  createZipStream,
  sanitizeZipFileName,
  ZipBusyError,
  ZipTooLargeError,
  ZipTooManyEntriesError,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_TOTAL_BYTES,
  type ZipStreamEntry,
} from '@/server/export/zip';
import { escapeCsvCell } from '@/server/export/csv';
import { fmtDateShort, fmtDateTimeLong } from '@/lib/fmt';
import { DOCUMENT_CLASSIFICATION_LABELS } from '@/lib/domain-labels';
import { isUuid } from '@/lib/uuid';
import { isDocumentVersionReady } from '@/server/documents/delivery-readiness';

const QuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .refine(({ from, to }) => !from || !to || from <= to);

const GOBD_CLASSIFICATIONS = ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'] as const;

const exportClassificationLabels: Readonly<Record<string, string>> = {
  ...DOCUMENT_CLASSIFICATION_LABELS,
  GOBD_INVOICE: 'Rechnung',
  GOBD_CONTRACT: 'Vertrag',
  GOBD_TAX: 'Steuer',
};

function mimeToExtension(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('tiff')) return 'tif';
  // OOXML ist ein Office-ZIP; die spezifischen MIME-Typen müssen vor dem
  // generischen XML-Fallback geprüft werden.
  if (m.includes('vnd.openxmlformats-officedocument.spreadsheetml')) return 'xlsx';
  if (m.includes('vnd.openxmlformats-officedocument.wordprocessingml')) return 'docx';
  if (m.includes('xml')) return 'xml';
  if (m.includes('xrechnung')) return 'xml';
  if (m.includes('csv')) return 'csv';
  if (m.includes('msword')) return 'doc';
  if (m.includes('excel')) return 'xls';
  return 'bin';
}

// H1: lokale csvEscape entfernt — zentraler escapeCsvCell aus
// @/server/export/csv hat die Formula-Injection-Mitigation (^[=+\-@\t\r] →
// Apostroph-Prefix), die hier sonst fehlen würde. Mandantenname wie
// `=cmd|'/c calc'!A0` hätte in Excel Code-Ausführung beim Öffnen.

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Per-User-Rate-Limit (Defense in Depth): ZIP-Builds sind die teuersten
  // Exporte (Objekt-Loads bis ZIP_MAX_TOTAL_BYTES). Greift VOR Größen-
  // Vorabcheck und ZIP-Slot.
  const exportRl = await checkStaffExportLimit('datev-belege', session.user.staffId);
  if (!exportRl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', retryAfter: exportRl.retryAfter },
      { status: 429 },
    );
  }

  const { id: clientId } = await params;
  // Prisma wirft bei Nicht-UUID P2023 → 500 statt 404. Wie in der
  // Portal-Schwesterroute vorab abweisen.
  if (!isUuid(clientId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const parsedQs = QuerySchema.safeParse(sp);
  if (!parsedQs.success) {
    return NextResponse.json({ error: 'invalid_query' }, { status: 400 });
  }
  const { tenantId, staffId } = session.user;

  const fromDate = parsedQs.data.from ? new Date(parsedQs.data.from + 'T00:00:00.000Z') : null;
  const toDate = parsedQs.data.to ? new Date(parsedQs.data.to + 'T23:59:59.999Z') : null;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // Audit Round 15, Finding 4: expliziter tenantId-Filter zusätzlich
      // zu RLS — ein DATEV-Belege-Export enthält alle GoBD-pflichtigen
      // Originale eines Mandanten; bei RLS-Drift wäre der Schaden total.
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { id: true, name: true, datevNo: true },
      });
      if (!client) return null;

      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): der Export enthält ALLE
      // GoBD-Originale des Mandanten — gesperrt → null → 404 (kein Existenz-
      // Leak), bevor Belege gelesen oder auditiert werden.
      if (!(await canAccessClientTx(tx, session, clientId))) return null;

      const candidates = await tx.document.findMany({
        where: {
          tenantId,
          clientId,
          classification: { in: [...GOBD_CLASSIFICATIONS] },
          ...(fromDate || toDate
            ? {
                createdAt: {
                  ...(fromDate ? { gte: fromDate } : {}),
                  ...(toDate ? { lte: toDate } : {}),
                },
              }
            : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          versions: { orderBy: { versionNo: 'desc' }, take: 1 },
          invoiceAttachments: {
            select: { number: true, issueDate: true, totalAmount: true },
            take: 1,
          },
        },
      });

      const docs = candidates.filter((doc) => isDocumentVersionReady(doc.versions[0]));

      return { client, docs };
    },
  );

  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const { client, docs } = data;

  // P-2: Gesamt-Größe AUS DER DB summieren und cappen, BEVOR auch nur ein
  // Objekt geladen wird. Vorher zog die Schleife bis zu 1 GB in den RAM und
  // erst buildZip lehnte ab — der Speicher war da längst belegt. Muster
  // identisch zur Schwester-Route api/staff/documents/download.
  let expectedBytes = 0n;
  for (const doc of docs) {
    const v = doc.versions[0];
    if (v) expectedBytes += v.sizeBytes;
  }
  if (expectedBytes > BigInt(ZIP_MAX_TOTAL_BYTES)) {
    const e = new ZipTooLargeError(Number(expectedBytes), ZIP_MAX_TOTAL_BYTES);
    return NextResponse.json(
      {
        error: 'zip_too_large',
        message: e.message,
        totalBytes: e.totalBytes,
        limitBytes: e.limitBytes,
      },
      { status: 413 },
    );
  }
  // F-18: Die Eintragszahl (Belege + index.csv + manifest.txt) steht ebenfalls
  // vorab fest — vor dem Audit prüfen statt erst nach dem Laden in buildZip.
  if (docs.length + 2 > ZIP_MAX_ENTRIES) {
    const e = new ZipTooManyEntriesError(docs.length + 2, ZIP_MAX_ENTRIES);
    return NextResponse.json(
      { error: 'zip_too_many_entries', message: e.message },
      { status: 413 },
    );
  }

  // P-6/P-03: Slot aus dem Pool für gestreamte Exporte (ZIP_MAX_PARALLEL_STREAMS).
  // Er bleibt belegt, bis das Archiv übertragen, fehlgeschlagen oder vom Client
  // abgebrochen ist (onSettled), nicht nur bis die Response zurückgeht.
  let releaseZipSlot: () => void;
  try {
    releaseZipSlot = await acquireZipStreamSlot();
  } catch (err) {
    if (err instanceof ZipBusyError) {
      return NextResponse.json({ error: 'zip_busy', message: err.message }, { status: 429 });
    }
    throw err;
  }
  try {
    // F-18: Audit erst NACH Größen-, Eintrags- und Slot-Prüfung (Muster der
    // Schwester-Route api/staff/documents/download). Vorher stand der Eintrag in
    // der Lese-Transaktion — das Prüfprotokoll wies so auch Exporte aus, die
    // anschließend mit 413/429 abgelehnt und nie ausgeliefert wurden.
    // A10: Der Nachweis trägt wie `document.download.bulk` alle Dokument-IDs in
    // Archivreihenfolge (laufende Nummer in index.csv). Die Liste wird nicht
    // gekürzt; die Eintragsprüfung oben begrenzt sie auf ZIP_MAX_ENTRIES − 2.
    // Ein Beleg, dessen Objekt erst beim Streamen fehlt, bleibt darin und steht
    // in index.csv als FEHLT.
    await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.belege.export',
        resourceType: 'client',
        resourceId: clientId,
        after: {
          documents: docs.length,
          documentIds: docs.map((doc) => doc.id),
          from: parsedQs.data.from ?? null,
          to: parsedQs.data.to ?? null,
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      }),
    );

    // P-03: ZIP streamen statt puffern. Die Belege werden nacheinander erst dann
    // aus S3 gelesen, wenn der Client die vorherigen Bytes abgenommen hat;
    // index.csv und manifest.txt folgen am Ende, weil sie fehlende Belege
    // ("FEHLT") und die tatsächlich gelieferte Anzahl ausweisen.
    // P-2: Der Backstop für tatsächlich gelesene Bytes (falls
    // DocumentVersion.sizeBytes von der Objektgröße abweicht) bricht den Stream
    // ab (maxSourceBytes), statt erst alles in den RAM zu laden.
    const exportedAt = new Date();
    const body = createZipStream(
      datevBelegeEntries({
        docs,
        client,
        exportedAt,
        exportedBy: session.user.fullName ?? session.user.email,
        from: parsedQs.data.from,
        to: parsedQs.data.to,
      }),
      {
        signal: req.signal,
        onSettled: releaseZipSlot,
        maxEntryBytes: MAX_UPLOAD_BYTES,
        maxSourceBytes: ZIP_MAX_TOTAL_BYTES,
      },
    );

    const zipName = `datev-belege_${(client.datevNo ?? 'mandant').replace(/[^A-Za-z0-9_-]/g, '_')}_${exportedAt.toISOString().slice(0, 10)}.zip`;

    // Ohne Content-Length: die Archivgröße steht erst nach dem Streamen fest.
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    releaseZipSlot();
    throw err;
  }
}

interface DatevBelegDocument {
  title: string;
  mimeType: string;
  classification: string;
  createdAt: Date;
  invoiceAttachments: { number: string | null; totalAmount: { toString(): string } | null }[];
  versions: {
    storageBucket: string;
    storageKey: string;
    storageVersionId: string | null;
    sha256: Uint8Array;
  }[];
}

const INDEX_HEADER = [
  'Lfd-Nr',
  'Datum',
  'Belegart',
  'Titel',
  'Belegnummer',
  'Betrag (EUR)',
  'Dateiname',
  'SHA-256',
]
  .map(escapeCsvCell)
  .join(';');

function indexRow(doc: DatevBelegDocument, seq: string, fileName: string, sha256: string): string {
  return [
    seq,
    fmtDateShort(doc.createdAt),
    exportClassificationLabels[doc.classification] ?? doc.classification,
    doc.title,
    doc.invoiceAttachments[0]?.number ?? '',
    doc.invoiceAttachments[0]?.totalAmount?.toString().replace('.', ',') ?? '',
    fileName,
    sha256,
  ]
    .map((v) => escapeCsvCell(String(v)))
    .join(';');
}

/**
 * P-03: Liefert die ZIP-Einträge in Archivreihenfolge. Jeder Beleg wird erst
 * geöffnet, wenn der Stream ihn schreibt (sequentiell, um S3 nicht zu
 * überfluten). Ein nicht abrufbares oder zu großes Objekt wird wie bisher
 * übersprungen und im Index als FEHLT markiert — auch wenn das Lesen erst
 * mittendrin scheitert (onReadError; der Writer schreibt einen Eintrag erst nach
 * dem vollständigen Lesen).
 */
async function* datevBelegeEntries(input: {
  docs: DatevBelegDocument[];
  client: { name: string; datevNo: string | null };
  exportedAt: Date;
  exportedBy: string;
  from: string | undefined;
  to: string | undefined;
}): AsyncGenerator<ZipStreamEntry> {
  const indexRows = [INDEX_HEADER];
  let delivered = 0;
  let lfd = 0;
  for (const doc of input.docs) {
    lfd += 1;
    const v = doc.versions[0];
    if (!v) continue;
    const ext = mimeToExtension(doc.mimeType);
    const seq = String(lfd).padStart(4, '0');
    const safeTitle = sanitizeZipFileName(doc.title, 80);
    const fileName = `belege/${seq}_${safeTitle}.${ext}`;

    let object: ObjectStream;
    try {
      // DOC-VERSION-IMMUTABILITY-001: gebundene S3-Version, kein Key-Fallback.
      object = await streamObject(v.storageBucket, v.storageKey, v.storageVersionId);
    } catch {
      // Fehlende Datei: Eintrag überspringen, im Index markieren
      indexRows.push(indexRow(doc, seq, 'FEHLT', ''));
      continue;
    }
    delivered += 1;
    const sha256 = Buffer.from(v.sha256).toString('hex');
    const rowIndex = indexRows.push(indexRow(doc, seq, fileName, sha256)) - 1;
    yield {
      name: fileName,
      data: object.body,
      modifiedAt: doc.createdAt,
      onReadError: () => {
        // index.csv entsteht erst nach allen Belegen: Zeile nachträglich umstellen.
        indexRows[rowIndex] = indexRow(doc, seq, 'FEHLT', '');
        delivered -= 1;
      },
    };
  }

  // index.csv (UTF-8-BOM + CRLF für Excel-Kompatibilität)
  yield { name: 'index.csv', data: Buffer.from('\uFEFF' + indexRows.join('\r\n'), 'utf8') };

  // manifest.txt — menschenlesbare Übersicht
  const manifest = [
    `Mandant: ${input.client.name}`,
    `DATEV-Nr.: ${input.client.datevNo ?? '—'}`,
    `Export erstellt: ${fmtDateTimeLong(input.exportedAt)}`,
    `Erstellt von: ${input.exportedBy}`,
    `Zeitraum: ${input.from ?? '*'} bis ${input.to ?? '*'}`,
    `Anzahl Belege: ${delivered} (von ${input.docs.length} insgesamt)`,
    '',
    'Hinweis: Die SHA-256-Hashes in index.csv können gegen den taxtronik-Audit-Log',
    'verifiziert werden (audit_log.action = document.commit).',
    '',
  ].join('\r\n');
  yield { name: 'manifest.txt', data: Buffer.from(manifest, 'utf8') };
}

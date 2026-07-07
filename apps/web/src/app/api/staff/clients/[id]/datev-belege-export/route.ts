// =============================================================================
// DATEV-Belege-Export — ZIP für einen Mandanten
//
// Lädt alle GoBD-Belege (Rechnungen, Verträge, Steuer-Belege) als ZIP mit:
//   - belege/<lfd-nr>_<title>.<ext>     (Original-Dateien)
//   - index.csv                          (DATEV-kompatible Begleitliste)
//   - manifest.txt                       (Lesbare Zusammenfassung)
//
// Optional Datumsbereich via Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD
// (filtert nach Document.createdAt)
//
// Audit-Eintrag pro Export-Vorgang (Compliance: wer hat wann was exportiert).
// =============================================================================
import { NextResponse, type NextRequest } from 'next/server';
import { getClientIp, checkStaffExportLimit } from '@/server/rate-limit';
import { z } from 'zod';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fetchObjectBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import {
  acquireZipBuildSlot,
  buildZip,
  sanitizeZipFileName,
  ZipBusyError,
  ZipTooLargeError,
  ZipTooManyEntriesError,
  ZIP_MAX_TOTAL_BYTES,
  type ZipEntry,
} from '@/server/export/zip';
import { escapeCsvCell } from '@/server/export/csv';
import { fmtDateShort, fmtDateTimeLong } from '@/lib/fmt';

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const GOBD_CLASSIFICATIONS = ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'] as const;

const classificationLabels: Record<string, string> = {
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
  if (m.includes('xml')) return 'xml';
  if (m.includes('xrechnung')) return 'xml';
  if (m.includes('csv')) return 'csv';
  if (m.includes('vnd.openxmlformats-officedocument.spreadsheetml')) return 'xlsx';
  if (m.includes('vnd.openxmlformats-officedocument.wordprocessingml')) return 'docx';
  if (m.includes('msword')) return 'doc';
  if (m.includes('excel')) return 'xls';
  return 'bin';
}

// H1: lokale csvEscape entfernt — zentraler escapeCsvCell aus
// @/server/export/csv hat die Formula-Injection-Mitigation (^[=+\-@\t\r] →
// Apostroph-Prefix), die hier sonst fehlen würde. Mandantenname wie
// `=cmd|'/c calc'!A0` hätte in Excel Code-Ausführung beim Öffnen.

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

      const docs = await tx.document.findMany({
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

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.belege.export',
        resourceType: 'client',
        resourceId: clientId,
        after: {
          documents: docs.length,
          from: parsedQs.data.from ?? null,
          to: parsedQs.data.to ?? null,
        },
        ip: getClientIp(req.headers),
        userAgent: req.headers.get('user-agent'),
      });

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
      { error: 'zip_too_large', message: e.message, totalBytes: e.totalBytes, limitBytes: e.limitBytes },
      { status: 413 },
    );
  }

  // P-6: Build-Slot — max. 2 parallele ZIP-Builds pro Instanz (RAM-Schutz).
  let releaseZipSlot: () => void;
  try {
    releaseZipSlot = await acquireZipBuildSlot();
  } catch (err) {
    if (err instanceof ZipBusyError) {
      return NextResponse.json({ error: 'zip_busy', message: err.message }, { status: 429 });
    }
    throw err;
  }
  try {
    // Belege als Bytes laden — sequentiell, um S3 nicht zu überfluten
    const fileEntries: ZipEntry[] = [];
    const indexRows: string[] = [];
    indexRows.push(
      ['Lfd-Nr', 'Datum', 'Belegart', 'Titel', 'Belegnummer', 'Betrag (EUR)', 'Dateiname', 'SHA-256']
        .map(escapeCsvCell)
        .join(';'),
    );

    // P-2: laufende Summe der TATSÄCHLICH geladenen Bytes als Backstop —
    // falls DocumentVersion.sizeBytes von der Objektgröße abweicht.
    let loadedBytes = 0;
    let lfd = 0;
    for (const doc of docs) {
      lfd += 1;
      const v = doc.versions[0];
      if (!v) continue;
      const ext = mimeToExtension(doc.mimeType);
      const seq = String(lfd).padStart(4, '0');
      const safeTitle = sanitizeZipFileName(doc.title, 80);
      const fileName = `belege/${seq}_${safeTitle}.${ext}`;

      let bytes: Buffer;
      try {
        bytes = await fetchObjectBytes(v.storageBucket, v.storageKey);
      } catch {
        // Fehlende Datei: Eintrag überspringen, im Index markieren
        indexRows.push(
          [
            seq,
            fmtDateShort(doc.createdAt),
            classificationLabels[doc.classification] ?? doc.classification,
            doc.title,
            doc.invoiceAttachments[0]?.number ?? '',
            doc.invoiceAttachments[0]?.totalAmount?.toString().replace('.', ',') ?? '',
            'FEHLT',
            '',
          ]
            .map((v) => escapeCsvCell(String(v)))
            .join(';'),
        );
        continue;
      }

      loadedBytes += bytes.length;
      if (loadedBytes > ZIP_MAX_TOTAL_BYTES) {
        const e = new ZipTooLargeError(loadedBytes, ZIP_MAX_TOTAL_BYTES);
        return NextResponse.json(
          { error: 'zip_too_large', message: e.message, totalBytes: e.totalBytes, limitBytes: e.limitBytes },
          { status: 413 },
        );
      }

      fileEntries.push({ name: fileName, data: bytes, modifiedAt: doc.createdAt });
      indexRows.push(
        [
          seq,
          fmtDateShort(doc.createdAt),
          classificationLabels[doc.classification] ?? doc.classification,
          doc.title,
          doc.invoiceAttachments[0]?.number ?? '',
          doc.invoiceAttachments[0]?.totalAmount?.toString().replace('.', ',') ?? '',
          fileName,
          Buffer.from(v.sha256).toString('hex'),
        ]
          .map((v) => escapeCsvCell(String(v)))
          .join(';'),
      );
    }

    // index.csv (UTF-8-BOM + CRLF für Excel-Kompatibilität)
    const indexCsv = '﻿' + indexRows.join('\r\n');

    // manifest.txt — menschenlesbare Übersicht
    const manifest = [
      `Mandant: ${client.name}`,
      `DATEV-Nr.: ${client.datevNo ?? '—'}`,
      `Export erstellt: ${fmtDateTimeLong(new Date())}`,
      `Erstellt von: ${session.user.fullName ?? session.user.email}`,
      `Zeitraum: ${parsedQs.data.from ?? '*'} bis ${parsedQs.data.to ?? '*'}`,
      `Anzahl Belege: ${fileEntries.length} (von ${docs.length} insgesamt)`,
      '',
      'Hinweis: Die SHA-256-Hashes in index.csv können gegen den taxtronik-Audit-Log',
      'verifiziert werden (audit_log.action = document.commit).',
      '',
    ].join('\r\n');

    const allEntries: ZipEntry[] = [
      { name: 'index.csv', data: Buffer.from(indexCsv, 'utf8') },
      { name: 'manifest.txt', data: Buffer.from(manifest, 'utf8') },
      ...fileEntries,
    ];

    let zipBytes: Buffer;
    try {
      zipBytes = buildZip(allEntries);
    } catch (err) {
      if (err instanceof ZipTooLargeError) {
        // T-4: Klare Fehlermeldung statt OOM. UI sollte den Hinweis anzeigen
        // und den Admin auf engere Datumsbereiche lenken.
        return NextResponse.json(
          {
            error: 'zip_too_large',
            message: err.message,
            totalBytes: err.totalBytes,
            limitBytes: err.limitBytes,
          },
          { status: 413 },
        );
      }
      if (err instanceof ZipTooManyEntriesError) {
        return NextResponse.json(
          { error: 'zip_too_many_entries', message: err.message },
          { status: 413 },
        );
      }
      throw err;
    }

    const zipName = `datev-belege_${(client.datevNo ?? 'mandant').replace(/[^A-Za-z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.zip`;

    return new Response(new Uint8Array(zipBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Content-Length': String(zipBytes.length),
        'Cache-Control': 'no-store',
      },
    });
  } finally {
    releaseZipSlot();
  }
}

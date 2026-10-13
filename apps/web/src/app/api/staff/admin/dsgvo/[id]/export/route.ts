// =============================================================================
// GET /api/staff/admin/dsgvo/[id]/export — DSGVO-Kontaktpaket herunterladen
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001
//
// Welle 15 (Folgepunkt P-11): Das Paket erzeugt der Worker dsgvo-export und legt
// es im Object Store ab. Nur ADMIN/PARTNER; ausgeliefert wird das am Antrag
// gebundene Ergebnis nach Größen- und Hash-Prüfung, auditiert als
// dsgvo.export.download (server/dsgvo/export-download.ts).
// =============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { bytesResponseBody, sanitizeFilenameForHeader } from '@taxtronik/storage';
import { staffActionGuard } from '@/server/actions/staff-action';
import { log } from '@/server/logger';
import {
  DsgvoExportUnavailableError,
  loadDsgvoExportDownload,
} from '@/server/dsgvo/export-download';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const guard = await staffActionGuard({
    requireAdmin: true,
    deniedMessage: 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.',
  });
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: 403 });
  try {
    const download = await loadDsgvoExportDownload(
      { ...guard.ctx, actorId: guard.staffId },
      parsed.data,
    );
    return new NextResponse(bytesResponseBody(download.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${sanitizeFilenameForHeader(download.filename)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof DsgvoExportUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    log.error(
      {
        component: 'dsgvo-export-download',
        requestId: parsed.data,
        err: error instanceof Error ? error.message : String(error),
      },
      'dsgvo-export: Paket nicht ausgeliefert',
    );
    return NextResponse.json(
      { error: 'Das Paket konnte nicht geprüft ausgeliefert werden.' },
      { status: 502 },
    );
  }
}

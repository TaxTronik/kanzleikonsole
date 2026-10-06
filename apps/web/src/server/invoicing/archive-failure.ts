// =============================================================================
// Einheitliche Antwort der E-Rechnungsabrufe (XRechnung-XML, ZUGFeRD-PDF) und
// der Archivfehler im Versand: ein Code → Status + deutsche Meldung.
//
// Technische Fehlertexte (PDF-Generierung, Object-Store, DB) gehen NUR ins
// Server-Log; der Client erhält ausschließlich die feste Meldung zum Code.
// =============================================================================

import { NextResponse } from 'next/server';
import { log } from '@/server/logger';
import type { ArchiveFailureCode } from '@/server/invoicing/archive';

export type ArchiveRouteFailureCode =
  | ArchiveFailureCode
  /** Erzeugung oder revisionssichere Ablage ist mit einem Fehler abgebrochen. */
  | 'generation_failed'
  /** Archivpfad lief durch, die angeforderte Fassung ist aber nicht verknüpft. */
  | 'archive_failed'
  | 'timeout';

const SETTINGS_HINT = '(Einstellungen → Kanzlei-Stammdaten)';

const ARCHIVE_FAILURES: Record<ArchiveRouteFailureCode, { status: number; message: string }> = {
  not_found: { status: 404, message: 'Rechnung nicht gefunden.' },
  not_applicable: {
    status: 404,
    message: 'Rechnungen im Format „PDF“ haben keine XRechnung- oder ZUGFeRD-Fassung.',
  },
  seller_incomplete: {
    status: 422,
    message: `Kanzlei-Stammdaten unvollständig: Name, Straße, PLZ, Ort, E-Mail, Telefon sowie USt-IdNr oder Steuernummer sind Pflicht ${SETTINGS_HINT}.`,
  },
  reverse_charge_seller_no_vatid: {
    status: 422,
    message: `Reverse-Charge (§ 13b UStG) erfordert die USt-IdNr der Kanzlei ${SETTINGS_HINT}.`,
  },
  buyer_incomplete: {
    status: 422,
    message: 'Mandantenanschrift unvollständig: Straße, PLZ und Ort beim Mandanten ergänzen.',
  },
  status_conflict: {
    status: 409,
    message:
      'Die Rechnung wurde zwischenzeitlich geändert oder storniert. Bitte neu laden und erneut versuchen.',
  },
  generation_failed: {
    status: 502,
    message: 'Die E-Rechnung konnte nicht erzeugt oder archiviert werden. Bitte erneut versuchen.',
  },
  archive_failed: {
    status: 502,
    message: 'Die XRechnung wurde nicht im Archiv verknüpft. Bitte erneut versuchen.',
  },
  timeout: {
    status: 504,
    message: 'Zeitüberschreitung beim Erzeugen der E-Rechnung. Bitte erneut versuchen.',
  },
};

export interface ArchiveFailureDetail {
  route: 'xrechnung' | 'zugferd';
  tenantId: string;
  invoiceId: string;
  /** Ursache (nur Server-Log, nie im Response-Body). */
  error?: unknown;
}

/** Feste deutsche Meldung zu einem Archiv-Fehlercode (auch für Server Actions). */
export function archiveFailureMessage(code: ArchiveRouteFailureCode): string {
  return ARCHIVE_FAILURES[code].message;
}

/**
 * HTTP-Antwort `{ error: code, message }` mit dem Status des Codes. Technische
 * Fehler (5xx oder eine übergebene Ursache) werden mit `detail` serverseitig
 * geloggt; fachliche Ablehnungen (404/409/422) nicht.
 */
export function archiveFailureResponse(
  code: ArchiveRouteFailureCode,
  detail?: ArchiveFailureDetail,
): NextResponse {
  const failure = ARCHIVE_FAILURES[code];
  if (detail && (failure.status >= 500 || detail.error !== undefined)) {
    const cause =
      detail.error === undefined
        ? undefined
        : detail.error instanceof Error
          ? detail.error.message
          : String(detail.error);
    log.error(
      {
        component: 'invoice-archive-route',
        route: detail.route,
        tenantId: detail.tenantId,
        invoiceId: detail.invoiceId,
        code,
        err: cause,
      },
      'E-Rechnungsabruf fehlgeschlagen',
    );
  }
  return NextResponse.json({ error: code, message: failure.message }, { status: failure.status });
}

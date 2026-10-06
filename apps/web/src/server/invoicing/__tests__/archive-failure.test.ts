import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fachkatalog: INV-ARCHIVE-EINVOICE-001

const m = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: m.logError } }));

import {
  archiveFailureMessage,
  archiveFailureResponse,
  type ArchiveRouteFailureCode,
} from '../archive-failure';

beforeEach(() => {
  vi.clearAllMocks();
});

const EXPECTED: Array<[ArchiveRouteFailureCode, number, RegExp]> = [
  ['not_found', 404, /Rechnung nicht gefunden/],
  ['not_applicable', 404, /keine XRechnung- oder ZUGFeRD-Fassung/],
  ['seller_incomplete', 422, /USt-IdNr oder Steuernummer.*Kanzlei-Stammdaten/],
  ['reverse_charge_seller_no_vatid', 422, /§ 13b UStG.*USt-IdNr der Kanzlei/],
  ['buyer_incomplete', 422, /Straße, PLZ und Ort/],
  ['status_conflict', 409, /geändert oder storniert/],
  ['generation_failed', 502, /nicht erzeugt oder archiviert/],
  ['archive_failed', 502, /nicht im Archiv verknüpft/],
  ['timeout', 504, /Zeitüberschreitung/],
];

describe('archiveFailureResponse', () => {
  it.each(EXPECTED)('%s → %i mit deutscher Meldung', async (code, status, message) => {
    const response = archiveFailureResponse(code);

    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string; message: string };
    expect(body).toEqual({ error: code, message: archiveFailureMessage(code) });
    expect(body.message).toMatch(message);
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('loggt die technische Ursache nur serverseitig und gibt sie nie an den Client', async () => {
    const response = archiveFailureResponse('generation_failed', {
      route: 'zugferd',
      tenantId: 't1',
      invoiceId: 'inv1',
      error: new Error('S3 PutObject failed: AccessDenied arn:aws:s3:::gobd-bucket'),
    });

    const text = await response.text();
    expect(response.status).toBe(502);
    expect(text).not.toContain('AccessDenied');
    expect(text).not.toContain('gobd-bucket');
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        route: 'zugferd',
        tenantId: 't1',
        invoiceId: 'inv1',
        code: 'generation_failed',
        err: 'S3 PutObject failed: AccessDenied arn:aws:s3:::gobd-bucket',
      }),
      expect.any(String),
    );
  });

  it('loggt fachliche Ablehnungen ohne Ursache nicht', () => {
    archiveFailureResponse('seller_incomplete', {
      route: 'xrechnung',
      tenantId: 't1',
      invoiceId: 'inv1',
    });
    expect(m.logError).not.toHaveBeenCalled();
  });

  it('loggt 5xx auch ohne geworfene Ursache (z. B. nicht verknüpfte XML)', () => {
    archiveFailureResponse('archive_failed', {
      route: 'xrechnung',
      tenantId: 't1',
      invoiceId: 'inv1',
    });
    expect(m.logError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'archive_failed', err: undefined }),
      expect.any(String),
    );
  });
});

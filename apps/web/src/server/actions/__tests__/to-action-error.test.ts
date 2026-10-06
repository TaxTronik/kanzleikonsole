// =============================================================================
// Unit-Test: zentrales Fehler-Mapping (Review-Befund F-03).
// Fachkatalog: GWG-ACTIVATION-GATE-001
//
// Fachfehler erreichen das UI nur als ActionError; Datenbank- und Storage-
// Fehler werden über SQLSTATE bzw. Fehlerklasse eingeordnet, nie über den
// Meldungstext. Die echte Fehlerform der Trigger belegt der DB-Test
// packages/db/src/__tests__/database-error-classification.test.ts.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@taxtronik/db/prisma-client';
import { StoredObjectError, UploadRejectedError } from '@taxtronik/storage/errors';

vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from '@/server/logger';
import { ActionError, ForbiddenError, UnauthorizedError } from '../action-error';
import { toActionError, UNEXPECTED_ACTION_ERROR } from '../to-action-error';
import { networkFailure } from '@/server/http/network-error';
import { urlTargetErrorMessage, SsrfGuardError } from '@/server/http/ssrf-guard';
import { ModuleDisabledError } from '@/server/settings/modules';

function driverError(prismaCode: string, sqlState: string, originalMessage: string) {
  return new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${sqlState}\`.`, {
    code: prismaCode,
    clientVersion: 'test',
    meta: {
      modelName: 'Request',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { originalCode: sqlState, originalMessage, kind: 'postgres' },
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toActionError — Fachfehler', () => {
  it('reicht ActionError, Forbidden- und Unauthorized-Meldungen durch', () => {
    expect(toActionError(new ActionError('Name bereits vergeben.'))).toEqual({
      ok: false,
      error: 'Name bereits vergeben.',
    });
    expect(toActionError(new ForbiddenError()).error).toBe('Nur ADMIN/PARTNER.');
    expect(toActionError(new UnauthorizedError()).error).toBe('Nicht eingeloggt.');
  });

  it('reicht Unterklassen von ActionError durch (z. B. deaktiviertes Modul)', () => {
    expect(toActionError(new ModuleDisabledError('bwa')).error).toBe('Modul bwa ist deaktiviert.');
  });

  it('ersetzt ein schlichtes Error weiterhin generisch und loggt das Original', () => {
    expect(toActionError(new Error('Fachtext ohne ActionError'))).toEqual({
      ok: false,
      error: UNEXPECTED_ACTION_ERROR,
    });
    expect(log.error).toHaveBeenCalledOnce();
  });
});

describe('toActionError — Datenbankfehler nach SQLSTATE', () => {
  it('ordnet die GwG-Schranke (23514 + Marker) mit der bisherigen UI-Meldung ein', () => {
    const error = driverError(
      'P2039',
      '23514',
      'Mandant 7 ist nicht aktiv (GwG-Schranke). Anforderung abgewiesen.',
    );
    expect(toActionError(error)).toEqual({
      ok: false,
      error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).',
    });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('zeigt eine andere CHECK-Verletzung nicht als GwG-Schranke und ohne Rohtext', () => {
    const result = toActionError(
      driverError('P2039', '23514', 'new row violates check constraint "client_name_check"'),
    );
    expect(result).toEqual({ ok: false, error: 'Datenbankfehler.' });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('ordnet Unique- und FK-Verletzungen aus Raw-SQL (P2010) wie P2002/P2003 ein', () => {
    expect(toActionError(driverError('P2010', '23505', 'duplicate key')).error).toBe(
      'Eintrag existiert bereits (Eindeutigkeits-Konflikt).',
    );
    expect(toActionError(driverError('P2010', '23503', 'violates foreign key')).error).toBe(
      'Referenz auf nicht existierenden Datensatz.',
    );
  });

  it('leakt keine Trigger- oder Prisma-Meldung (enthält Quellpfade) ans UI', () => {
    const result = toActionError(
      driverError('P2039', 'P0001', 'Invalid payroll scope /app/src/server/payroll.ts:42'),
    );
    expect(result.error).toBe('Datenbankfehler.');
  });
});

describe('toActionError — Storage-Fehler nach Fehlerklasse', () => {
  it.each([
    ['INFECTED', 'Die Datei wurde vom Virenscanner abgewiesen.'],
    ['TOO_LARGE', 'Die Datei ist zu groß.'],
    [
      'SCAN_ERROR',
      'Der Virenscan ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.',
    ],
  ] as const)('UploadRejectedError %s → feste Meldung', (reason, message) => {
    expect(toActionError(new UploadRejectedError(reason, 'Detail')).error).toBe(message);
  });

  it('behält das Meldungsformat CODE: … für bestehende Aufrufer', () => {
    expect(new UploadRejectedError('INFECTED', 'x').message).toBe('INFECTED: x');
  });

  it('meldet eine unzulässige Frist nicht als Rohtext', () => {
    const result = toActionError(new UploadRejectedError('INVALID_RETENTION_YEARS', 'intern'));
    expect(result.error).toBe(UNEXPECTED_ACTION_ERROR);
  });

  it.each([
    ['TOO_LARGE', 'Die Datei ist zu groß.'],
    ['MISSING_BODY', 'Datei nicht verfügbar.'],
    ['HASH_MISMATCH', 'Dateiintegrität konnte nicht bestätigt werden.'],
  ] as const)('StoredObjectError %s → feste Meldung', (reason, message) => {
    expect(toActionError(new StoredObjectError(reason, 'Detail')).error).toBe(message);
  });
});

describe('Netzwerk- und Ziel-URL-Fehler nach Name bzw. Code', () => {
  it('erkennt Zeitüberschreitungen über den Fehlernamen und Timeout-Codes', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(networkFailure(abort)).toEqual({ kind: 'timeout' });
    expect(
      networkFailure(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
    ).toEqual({ kind: 'timeout' });
  });

  it('erkennt nicht erreichbare Ziele über den System-Fehlercode', () => {
    expect(
      networkFailure(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    ).toEqual({ kind: 'unreachable', code: 'ECONNREFUSED' });
    expect(networkFailure(new TypeError('fetch failed'))).toEqual({
      kind: 'unreachable',
      code: null,
    });
  });

  it('hält Prisma-Codes und Fachfehler aus der Netzwerk-Einordnung heraus', () => {
    expect(
      networkFailure(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }),
      ),
    ).toBeNull();
    expect(networkFailure(new ActionError('timed out'))).toBeNull();
  });

  it('meldet SSRF-Ablehnungen und nicht auflösbare Hosts ohne Rohtext', () => {
    expect(urlTargetErrorMessage(new SsrfGuardError('literal-ip', 'Direkte IP.'))).toBe(
      'Direkte IP.',
    );
    expect(
      urlTargetErrorMessage(
        Object.assign(new Error('getaddrinfo ENOTFOUND intern.local'), { code: 'ENOTFOUND' }),
      ),
    ).toBe('Hostname ist nicht auflösbar.');
    expect(urlTargetErrorMessage(new Error('anderer Fehler'))).toBeNull();
  });
});

// =============================================================================
// Unit-Test: toActionError aus rbac.ts.
//
// Audit Round 14, Finding 3: Unbekannte Errors dürfen NIE direkt ans UI
// durchgereicht werden — könnten Stacktraces oder DB-Internals leaken.
// Dieser Test fängt jede Regression, die das auflöst (etwa: "ah, wir
// werfen einfach `error: e.message` zurück, dann sehen wir die Ursache
// schneller im UI").
//
// Verwendet vi.mock, um den pino-Logger zu kapseln — der Test prüft nur
// das Rückgabeverhalten, nicht den Log-Side-Effect (Log-Inhalt wird im
// Production-Setup von Operations geprüft).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// Logger mocken, bevor rbac importiert wird — sonst zieht der pino-Import
// die echte ENV-Validierung an.
vi.mock('@/server/logger', () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// Auth-Modul wird transitiv gezogen, mocken wir auch.
vi.mock('@/server/auth/staff', () => ({
  staffAuth: vi.fn(),
}));

import { toActionError, UnauthorizedError, ForbiddenError } from '../rbac';
import { log } from '@/server/logger';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('toActionError', () => {
  it('UnauthorizedError → eigene Message wird durchgereicht', () => {
    const r = toActionError(new UnauthorizedError());
    expect(r).toEqual({ ok: false, error: 'Nicht eingeloggt.' });
  });

  it('ForbiddenError → eigene Message wird durchgereicht', () => {
    const r = toActionError(new ForbiddenError());
    expect(r).toEqual({ ok: false, error: 'Nur ADMIN/PARTNER.' });
  });

  it('Prisma P2025 (not found) → menschenlesbare Meldung, kein Stack', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const r = toActionError(e);
    expect(r).toEqual({ ok: false, error: 'Datensatz nicht gefunden oder bereits geändert.' });
  });

  it('Prisma P2002 (unique) → menschenlesbare Meldung', () => {
    const e = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(toActionError(e).error).toMatch(/existiert bereits/i);
  });

  it('Prisma-Unbekannt → generische "Datenbankfehler"-Meldung (keine Internals)', () => {
    const e = new Prisma.PrismaClientKnownRequestError(
      'P9999 — exotischer Fehler mit internem Pfad /var/lib/postgresql/data/base/16384/2615',
      { code: 'P9999', clientVersion: 'test' },
    );
    const r = toActionError(e);
    expect(r.error).toBe('Datenbankfehler.');
    expect(r.error).not.toMatch(/postgresql/);
    expect(r.error).not.toMatch(/P9999/);
  });

  it('Unbekannte Exception → generische Meldung, NIE die original-Message', () => {
    const e = new Error('Internal: connection to redis at 10.0.0.5:6379 timed out at /app/src/server/redis.ts:42');
    const r = toActionError(e);
    expect(r.ok).toBe(false);
    expect(r.error).not.toMatch(/redis/);
    expect(r.error).not.toMatch(/10\.0\.0\.5/);
    expect(r.error).not.toMatch(/app\/src\/server/);
    expect(r.error).toMatch(/Unerwarteter Fehler/);
  });

  it('Unbekannte Exception → Original landet im Logger (für Ops)', () => {
    const e = new Error('Original-Message für Ops');
    toActionError(e);
    expect(log.error).toHaveBeenCalledOnce();
    const [logArgs] = vi.mocked(log.error).mock.calls[0]!;
    expect(logArgs).toMatchObject({
      component: 'action-error',
      err: 'Original-Message für Ops',
    });
  });

  it('Nicht-Error-Wurf (etwa string oder number) → generische Meldung', () => {
    // Defensive: `throw "string"` ist schlechter Stil, aber kommt vor.
    const r = toActionError('boom');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unerwarteter Fehler/);
  });
});

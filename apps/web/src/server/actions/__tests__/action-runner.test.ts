// Review-Befund K-02: der eine Baustein für mehrphasige Actions. Geprüft wird
// die Reihenfolge (Gate → Prüfung → Arbeit → Revalidate), der unveränderte
// Rückkanal für Gate-, Validierungs- und Fachfehler und das zentrale
// Fehler-Mapping — mit dem echten toActionError statt eines Nachbaus.

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Prisma } from '@taxtronik/db/prisma-client';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn(), logError: vi.fn(), logWarn: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/server/logger', () => ({
  log: { error: h.logError, warn: h.logWarn, info: vi.fn(), debug: vi.fn() },
}));

import {
  createActionRunner,
  mapActionError,
  type ActionFailure,
  type ActionGuardResult,
  type ActionSuccess,
} from '../action-runner';
import type { ActionResult } from '../types';
import { ActionError } from '../action-error';
import { parseFormData, requireUuidParam } from '../form-data';
import { UNEXPECTED_ACTION_ERROR } from '../to-action-error';

type Ctx = { tenantId: string; staffId: string };
type GuardOptions = { requireAdmin?: boolean };

const CTX: Ctx = { tenantId: 'tenant-1', staffId: 'staff-1' };
const guard = vi.fn<(options?: GuardOptions) => Promise<ActionGuardResult<Ctx>>>();
const runAction = createActionRunner<Ctx, GuardOptions>(guard);

/** Prisma-P2002, wie database-error.ts ihn einordnet. */
function uniqueViolation(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  guard.mockReset().mockResolvedValue({ ok: true, ...CTX });
});

describe('createActionRunner — Ablauf', () => {
  it('reicht die Gate-Optionen durch und liefert die Gate-Ablehnung unverändert', async () => {
    guard.mockResolvedValueOnce({ ok: false, error: 'Nur ADMIN/PARTNER.' });
    const parse = vi.fn();
    const run = vi.fn();

    await expect(runAction({ guard: { requireAdmin: true }, parse, run })).resolves.toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    expect(guard).toHaveBeenCalledWith({ requireAdmin: true });
    expect(parse).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('prüft die Eingabe nach dem Gate und gibt Feldfehler unverändert zurück', async () => {
    const order: string[] = [];
    guard.mockImplementationOnce(async () => {
      order.push('guard');
      return { ok: true, ...CTX };
    });
    const formData = new FormData();
    formData.set('title', '');
    const run = vi.fn();

    const result = await runAction({
      parse: () => {
        order.push('parse');
        return parseFormData(z.object({ title: z.string().min(1, 'Pflichtfeld') }), formData);
      },
      run,
      revalidate: '/staff/x',
    });

    expect(order).toEqual(['guard', 'parse']);
    expect(result).toEqual({
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { title: ['Pflichtfeld'] },
    });
    expect(run).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('gibt Kontext und geprüfte Daten an run, mischt die Nutzlast ins Ergebnis und revalidiert', async () => {
    const run = vi.fn(async (g: Ctx, data: { title: string }) => ({
      id: `${g.tenantId}:${data.title}`,
    }));

    const result = await runAction({
      parse: () => ({ ok: true, data: { title: 'Akte' } }),
      run,
      revalidate: ['/staff/a', '/staff/b'],
    });

    expect(result).toEqual({ ok: true, id: 'tenant-1:Akte' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining(CTX), { title: 'Akte' });
    expect(h.revalidatePath.mock.calls).toEqual([['/staff/a'], ['/staff/b']]);
  });

  it('liefert ohne Nutzlast `{ ok: true }` und revalidiert einen einzelnen Pfad', async () => {
    await expect(
      runAction({ run: async () => undefined, revalidate: '/staff/x' }),
    ).resolves.toEqual({ ok: true });
    expect(h.revalidatePath).toHaveBeenCalledOnce();
    expect(h.revalidatePath).toHaveBeenCalledWith('/staff/x');
  });

  it('reicht ein von run geliefertes Fehlerergebnis samt Zusatzfeldern ohne Revalidate durch', async () => {
    const failure = {
      ok: false as const,
      error: 'Zu viele Aktionen. Bitte 2 Min. warten.',
      errorCode: 'RATE_LIMITED' as const,
    };

    await expect(runAction({ run: async () => failure, revalidate: '/x' })).resolves.toBe(failure);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('createActionRunner — zentrales Fehler-Mapping', () => {
  it('meldet einen ActionError aus run mit seiner Meldung und revalidiert nicht', async () => {
    await expect(
      runAction({
        run: async () => {
          throw new ActionError('Anforderung nicht gefunden.');
        },
        revalidate: '/x',
      }),
    ).resolves.toEqual({ ok: false, error: 'Anforderung nicht gefunden.' });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('ordnet Fehler aus der Eingabeprüfung ebenfalls zentral ein', async () => {
    await expect(
      runAction({
        parse: () => ({ ok: true, data: requireUuidParam('keine-uuid') }),
        run: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, error: 'Ungültige Kennung.' });
  });

  it('übersetzt Eindeutigkeits-Konflikte nur mit uniqueError in die freundliche Meldung', async () => {
    const run = async () => {
      throw uniqueViolation();
    };

    await expect(runAction({ run, uniqueError: 'Name bereits vergeben.' })).resolves.toEqual({
      ok: false,
      error: 'Name bereits vergeben.',
    });
    await expect(runAction({ run })).resolves.toEqual({
      ok: false,
      error: 'Eintrag existiert bereits (Eindeutigkeits-Konflikt).',
    });
  });

  it('nutzt onError zuerst und fällt bei undefined auf das zentrale Mapping zurück', async () => {
    class ResumableError extends Error {}
    const onError = vi.fn((error: unknown) =>
      error instanceof ResumableError
        ? { ok: false as const, error: 'Fortsetzbar.', errorCode: 'CONFLICT' as const }
        : undefined,
    );

    await expect(
      runAction({
        run: async () => {
          throw new ResumableError('intern');
        },
        onError,
      }),
    ).resolves.toEqual({ ok: false, error: 'Fortsetzbar.', errorCode: 'CONFLICT' });
    await expect(
      runAction({
        run: async () => {
          throw new ActionError('Fachfehler.');
        },
        onError,
      }),
    ).resolves.toEqual({ ok: false, error: 'Fachfehler.' });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('gibt unbekannte Fehler nie roh weiter, sondern loggt sie', async () => {
    await expect(
      runAction({
        run: async () => {
          throw new Error('connect ECONNREFUSED /var/run/secret.sock');
        },
      }),
    ).resolves.toEqual({ ok: false, error: UNEXPECTED_ACTION_ERROR });
    expect(h.logError).toHaveBeenCalledOnce();
  });

  it('ordnet Ausfälle des Gates selbst zentral ein, statt zu werfen', async () => {
    const run = vi.fn();
    guard.mockRejectedValueOnce(
      Object.assign(new Error('Redis down'), { name: 'SessionRevocationUnavailableError' }),
    );
    await expect(runAction({ run })).resolves.toEqual({
      ok: false,
      error: 'Session-Widerruf ist derzeit nicht verfügbar.',
    });

    guard.mockRejectedValueOnce(new Error('Session-Store nicht erreichbar'));
    await expect(runAction({ run })).resolves.toEqual({
      ok: false,
      error: UNEXPECTED_ACTION_ERROR,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('mapActionError bündelt uniqueError und toActionError für alle Bausteine', () => {
    expect(mapActionError(uniqueViolation(), { uniqueError: 'Doppelt.' })).toEqual({
      ok: false,
      error: 'Doppelt.',
    });
    expect(mapActionError(new ActionError('Klartext.'))).toEqual({ ok: false, error: 'Klartext.' });
  });
});

describe('createActionRunner — Typinferenz (tsc prüft diese Datei mit)', () => {
  it('leitet die Nutzlast ohne frühe Fehlerzweige ab und typisiert die geprüften Daten', async () => {
    const withPayload = await runAction({
      parse: () => ({ ok: true as const, data: { title: 'x' } }),
      run: async (_g, data) => {
        expectTypeOf(data).toEqualTypeOf<{ title: string }>();
        if (!data.title) return { ok: false, error: 'Titel fehlt.' };
        if (data.title === '?') return { ok: false, error: 'Unklar.', errorCode: 'CONFLICT' };
        return { id: 'akte-1' };
      },
    });
    expectTypeOf(withPayload.error).toEqualTypeOf<string | undefined>();
    expectTypeOf(withPayload.ok).toEqualTypeOf<boolean>();
    if (!withPayload.ok) throw new Error('unerwartet');
    // Nach der Unterscheidung ist die Nutzlast vollständig (z. B. für redirect()).
    expectTypeOf(withPayload.id).toEqualTypeOf<string>();
    expect(withPayload).toEqual({ ok: true, id: 'akte-1' });
  });

  it('typisiert Läufe ohne Nutzlast als schlichtes Ergebnis', async () => {
    const voidRun = await runAction({ run: async () => undefined });
    expectTypeOf(voidRun).toExtend<ActionResult>();
    if (voidRun.ok) expectTypeOf(voidRun).toEqualTypeOf<ActionSuccess<Record<never, never>>>();

    const optionalPayload = await runAction({
      run: async (): Promise<{ id: string } | ActionFailure | void> => undefined,
    });
    // Ein Zweig ohne Rückgabewert macht die Nutzlast nicht verbindlich.
    if (optionalPayload.ok) {
      expectTypeOf(optionalPayload).toEqualTypeOf<
        | ActionSuccess<Omit<{ id: string }, keyof ActionResult>>
        | ActionSuccess<Record<never, never>>
      >();
    }
  });
});

// F-05: Unerwartete Fehler der Lohn-Actions bleiben für Nutzer generisch, stehen
// aber im Log; erwartbare Fachfehler werden nicht geloggt.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const h = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: h.logError } }));
vi.mock('../storage', () => ({ PayrollUploadError: class PayrollUploadError extends Error {} }));
vi.mock('@/server/documents/pdf-fonts', () => ({
  UnsupportedPdfTextError: class UnsupportedPdfTextError extends Error {},
}));

import { ActionError } from '@/server/actions/action-error';
import { payrollAction, payrollActionError } from '../action-result';

const GENERIC =
  'Der Vorgang konnte nicht gespeichert werden. Bitte neu laden oder die Kanzlei kontaktieren.';

beforeEach(() => {
  h.logError.mockClear();
});

describe('F-05 payrollActionError', () => {
  it('loggt einen unerwarteten Fehler und meldet generisch', () => {
    expect(payrollActionError(new Error('connection terminated'))).toEqual({
      ok: false,
      error: GENERIC,
    });
    expect(h.logError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        component: 'payroll-action',
        errName: 'Error',
        err: 'connection terminated',
      }),
      'payroll: unbehandelte Exception',
    );
  });

  it('loggt erwartbare Fach- und Eingabefehler nicht', () => {
    expect(payrollActionError(new ActionError('Anlage nicht verfügbar.'))).toEqual({
      ok: false,
      error: 'Anlage nicht verfügbar.',
    });
    expect(payrollActionError(new z.ZodError([]))).toEqual({
      ok: false,
      error: 'Eingaben und Pflichtfelder prüfen.',
    });
    expect(h.logError).not.toHaveBeenCalled();
  });

  it('gilt auch für den Gastzugang über payrollAction', async () => {
    await expect(
      payrollAction(async () => {
        throw new TypeError('kaputt');
      }),
    ).resolves.toEqual({ ok: false, error: GENERIC });
    expect(h.logError).toHaveBeenCalledOnce();
  });
});

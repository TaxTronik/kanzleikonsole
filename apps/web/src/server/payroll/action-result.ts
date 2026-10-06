import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { ActionError } from '@/server/actions/action-error';
import { PayrollUploadError } from './storage';
import type { PayrollActionResult } from '@/components/payroll-action-form';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';

/** Jede Lohn-Mutation revalidiert alle drei Oberflächen (Kanzlei, Portal, Gastzugang). */
export const PAYROLL_REVALIDATE_PATHS = [
  '/staff/payroll',
  '/portal/payroll',
  '/payroll/employee',
] as const;

/**
 * Lohn-eigenes Fehler-Mapping (Review-Befund K-02: eine Quelle für payrollAction
 * und die Lohn-Actions über staffAction/portalAction): fachliche Meldungen
 * gehen durch, ZodError wird „Eingaben und Pflichtfelder prüfen.“, alles
 * Übrige eine neutrale Lohn-Meldung.
 */
export function payrollActionError(error: unknown): PayrollActionResult & {
  ok: false;
  error: string;
} {
  if (error instanceof PayrollUploadError)
    return { ok: false, error: error.message, pendingId: error.pendingId };
  if (error instanceof ActionError) return { ok: false, error: error.message };
  if (error instanceof UnsupportedPdfTextError) return { ok: false, error: error.message };
  if (error instanceof z.ZodError)
    return { ok: false, error: 'Eingaben und Pflichtfelder prüfen.' };
  return {
    ok: false,
    error:
      'Der Vorgang konnte nicht gespeichert werden. Bitte neu laden oder die Kanzlei kontaktieren.',
  };
}

/** Lohn-Ablauf ohne Sitzungs-Gate (Gastzugang: die Capability prüft `work` selbst). */
export async function payrollAction(
  work: () => Promise<Partial<PayrollActionResult> | void>,
): Promise<PayrollActionResult> {
  try {
    const result = await work();
    for (const path of PAYROLL_REVALIDATE_PATHS) revalidatePath(path);
    return { ok: true, ...result };
  } catch (error) {
    return payrollActionError(error);
  }
}

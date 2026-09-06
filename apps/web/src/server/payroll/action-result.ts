import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { ActionError } from '@/server/actions/action-error';
import { PayrollUploadError } from './storage';
import type { PayrollActionResult } from '@/components/payroll-action-form';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';
export async function payrollAction(
  work: () => Promise<Partial<PayrollActionResult> | void>,
): Promise<PayrollActionResult> {
  try {
    const result = await work();
    revalidatePath('/staff/payroll');
    revalidatePath('/portal/payroll');
    revalidatePath('/payroll/employee');
    return { ok: true, ...result };
  } catch (error) {
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
}

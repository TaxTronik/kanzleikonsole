'use server';
import { z } from 'zod';
import { portalAction } from '@/server/actions/portal-action';
import { saveEmployer, issueEmployeeInvite } from '@/server/payroll/service';
import { PAYROLL_REVALIDATE_PATHS, payrollActionError } from '@/server/payroll/action-result';
import type { PayrollActionResult } from '@/components/payroll-action-form';
import { persistPayrollFile } from '@/server/payroll/storage';
import { ActionError } from '@/server/actions/action-error';
import { checkPortalWriteLimit } from '@/server/rate-limit';
import { payrollGuard } from '@/server/payroll/service';

/**
 * Lohnvorgänge des Arbeitgebers im Portal: Gate (Modul), Schreib-Backstop, dann
 * die Arbeit mit dem Lohn-eigenen Fehler-Mapping und Revalidate.
 */
function payrollEmployerAction(
  work: () => Promise<Partial<PayrollActionResult> | void>,
): Promise<PayrollActionResult> {
  return portalAction({
    guard: { module: 'payrollIntake' },
    run: async (g) => {
      if (!(await checkPortalWriteLimit(g.contactId)).ok)
        return { ok: false, error: 'Zu viele Aktionen.' };
      return work();
    },
    revalidate: PAYROLL_REVALIDATE_PATHS,
    onError: payrollActionError,
  });
}
export async function saveEmployerAction(data: FormData) {
  return payrollEmployerAction(async () => {
    const g = await payrollGuard('portal');
    if (!(await checkPortalWriteLimit(g.ctx.actorId!)).ok)
      throw new ActionError('Zu viele Aktionen.');
    await saveEmployer('portal', data);
  });
}
export async function issueEmployeeInviteAction(data: FormData) {
  return payrollEmployerAction(async () => ({
    link: await issueEmployeeInvite('portal', data),
    message:
      'Neuer Einmallink. Frühere Links und Sessions sind widerrufen. Bitte ausschließlich an die betroffene Person übermitteln.',
  }));
}
export async function uploadEmployerPayrollAction(data: FormData) {
  return payrollEmployerAction(async () => {
    const id = z.uuid().parse(data.get('id'));
    const resume = z.union([z.uuid(), z.literal('')]).parse(data.get('resumeId') ?? '');
    const file = data.get('file');
    const result = await persistPayrollFile({
      surface: 'portal',
      intakeId: id,
      filename: file instanceof File ? file.name : 'Anlage',
      bytes: async () => {
        if (!(file instanceof File)) throw new ActionError('Datei auswählen.');
        return Buffer.from(await file.arrayBuffer());
      },
      ...(resume ? { resumeId: resume } : {}),
    });
    return { message: 'Anlage gespeichert: ' + result.filename };
  });
}

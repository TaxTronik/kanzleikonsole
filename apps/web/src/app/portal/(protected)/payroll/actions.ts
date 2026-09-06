'use server';
import { z } from 'zod';
import { portalActionGuard } from '@/server/actions/portal-action';
async function guardPayrollEmployer(work: Parameters<typeof payrollAction>[0]) {
  const g = await portalActionGuard({ module: 'payrollIntake' });
  if (!g.ok) return g;
  if (!(await checkPortalWriteLimit(g.contactId)).ok)
    return { ok: false, error: 'Zu viele Aktionen.' };
  return payrollAction(work);
}
import { saveEmployer, issueEmployeeInvite } from '@/server/payroll/service';
import { payrollAction } from '@/server/payroll/action-result';
import { persistPayrollFile } from '@/server/payroll/storage';
import { ActionError } from '@/server/actions/action-error';
import { checkPortalWriteLimit } from '@/server/rate-limit';
import { payrollGuard } from '@/server/payroll/service';
export async function saveEmployerAction(data: FormData) {
  return guardPayrollEmployer(async () => {
    const g = await payrollGuard('portal');
    if (!(await checkPortalWriteLimit(g.ctx.actorId!)).ok)
      throw new ActionError('Zu viele Aktionen.');
    await saveEmployer('portal', data);
  });
}
export async function issueEmployeeInviteAction(data: FormData) {
  return guardPayrollEmployer(async () => ({
    link: await issueEmployeeInvite('portal', data),
    message:
      'Neuer Einmallink. Frühere Links und Sessions sind widerrufen. Bitte ausschließlich an die betroffene Person übermitteln.',
  }));
}
export async function uploadEmployerPayrollAction(data: FormData) {
  return guardPayrollEmployer(async () => {
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

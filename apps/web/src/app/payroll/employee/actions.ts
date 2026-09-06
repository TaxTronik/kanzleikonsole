'use server';
import { z } from 'zod';
import {
  guardPayrollEmployeeEntry,
  guardPayrollEmployee,
  guardPayrollEmployeeLogout,
  withPayrollCapability,
} from '@/server/payroll/capability';
import { payrollAction } from '@/server/payroll/action-result';
import { payrollAnswers } from '@/server/payroll/service';
import { validatePayrollAnswers } from '@/server/payroll/definition';
import { persistPayrollFile } from '@/server/payroll/storage';
import { ActionError } from '@/server/actions/action-error';
import { revalidatePath } from 'next/cache';
export async function enterEmployeeAction(data: FormData) {
  return payrollAction(async () => {
    if (!(await guardPayrollEmployeeEntry(data.get('token'))))
      throw new ActionError(
        'Link ungültig, verbraucht oder abgelaufen. Bitte einen neuen Link anfordern.',
      );
    return { message: 'Einzelvorgang geöffnet. Die Sitzung gilt höchstens acht Stunden.' };
  });
}
export async function saveEmployeeAction(data: FormData) {
  return payrollAction(async () => {
    const { hash, item } = await guardPayrollEmployee();
    const revision = z.coerce.number().int().nonnegative().parse(data.get('revision'));
    const submit = data.get('submit') === '1';
    const answers = payrollAnswers(data, item.schema);
    const errors = validatePayrollAnswers('employee', answers, submit, item.schema);
    if (submit && data.get('confirmed') !== 'on')
      errors.push('Eigene Angaben vor Abgabe bestätigen.');
    if (errors.length) throw new ActionError(errors.join(' '));
    const saved = await withPayrollCapability(
      async (tx) =>
        (
          await tx.$queryRaw<
            Array<{ saved: boolean }>
          >`SELECT app.payroll_guest_save(${hash},${revision},${JSON.stringify(answers)}::jsonb,${submit}) AS saved`
        )[0]?.saved,
    );
    if (!saved)
      throw new ActionError('Vorgang wurde geändert, abgegeben oder geschlossen. Bitte neu laden.');
  });
}
export async function uploadEmployeeAction(data: FormData) {
  return payrollAction(async () => {
    const { item } = await guardPayrollEmployee();
    const resume = z.union([z.uuid(), z.literal('')]).parse(data.get('resumeId') ?? '');
    const file = data.get('file');
    const result = await persistPayrollFile({
      surface: 'employee',
      intakeId: item.id,
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
export async function leaveEmployeeAction() {
  await guardPayrollEmployeeLogout();
  revalidatePath('/payroll/employee');
}

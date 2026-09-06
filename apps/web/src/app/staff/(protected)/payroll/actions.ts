'use server';
import { z } from 'zod';
import { staffActionGuard } from '@/server/actions/staff-action';
async function guardPayrollStaff(work: Parameters<typeof payrollAction>[0]) {
  const g = await staffActionGuard({
    module: 'payrollIntake',
    requirePermission: 'PAYROLL_MANAGE',
  });
  if (!g.ok) return g;
  return payrollAction(work);
}
import {
  createPayroll,
  saveEmployer,
  issueEmployeeInvite,
  reviewPayroll,
  confirmPayrollNumbers,
  recordImmediateRegistration,
  checkDatevGate,
} from '@/server/payroll/service';
import { payrollAction } from '@/server/payroll/action-result';
import { persistPayrollFile } from '@/server/payroll/storage';
import { createPayrollExport } from '@/server/payroll/export';
import { ActionError } from '@/server/actions/action-error';
export async function createPayrollAction(data: FormData) {
  return guardPayrollStaff(async () => ({
    link: '/staff/payroll?id=' + (await createPayroll(data)),
  }));
}
export async function saveEmployerDraftAction(data: FormData) {
  return guardPayrollStaff(() => saveEmployer('staff', data));
}
export async function issueEmployeeInviteAction(data: FormData) {
  return guardPayrollStaff(async () => ({
    link: await issueEmployeeInvite('staff', data),
    message:
      'Neuer Einmallink erstellt. Frühere Einladungen und ihre Sessions sind widerrufen. Nur der betroffenen Person sicher übermitteln.',
  }));
}
export async function reviewPayrollAction(data: FormData) {
  return guardPayrollStaff(() => reviewPayroll(data));
}
export async function confirmPayrollNumbersAction(data: FormData) {
  return guardPayrollStaff(() => confirmPayrollNumbers(data));
}
export async function recordImmediateRegistrationAction(data: FormData) {
  return guardPayrollStaff(() => recordImmediateRegistration(data));
}
export async function checkDatevGateAction(data: FormData) {
  return guardPayrollStaff(async () => ({ message: await checkDatevGate(data) }));
}
export async function createPayrollExportAction(data: FormData) {
  return guardPayrollStaff(async () => ({ link: await createPayrollExport(data) }));
}
export async function uploadPayrollAction(data: FormData) {
  return guardPayrollStaff(async () => {
    const id = z.uuid().parse(data.get('id'));
    const resume = z.union([z.uuid(), z.literal('')]).parse(data.get('resumeId') ?? '');
    const file = data.get('file');
    const result = await persistPayrollFile({
      surface: 'staff',
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

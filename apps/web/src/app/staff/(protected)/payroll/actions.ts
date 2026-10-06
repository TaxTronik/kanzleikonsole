'use server';
import { z } from 'zod';
import { staffAction } from '@/server/actions/staff-action';
import {
  createPayroll,
  saveEmployer,
  issueEmployeeInvite,
  reviewPayroll,
  confirmPayrollNumbers,
  recordImmediateRegistration,
  checkDatevGate,
} from '@/server/payroll/service';
import { PAYROLL_REVALIDATE_PATHS, payrollActionError } from '@/server/payroll/action-result';
import type { PayrollActionResult } from '@/components/payroll-action-form';
import { persistPayrollFile } from '@/server/payroll/storage';
import { createPayrollExport } from '@/server/payroll/export';
import { ActionError } from '@/server/actions/action-error';
import { withTenantContext } from '@taxtronik/db';
import { assertClientAccessTx } from '@/server/auth/rbac';
/**
 * Lohnvorgänge der Kanzlei: Gate (Modul + PAYROLL_MANAGE), dann die Arbeit mit
 * dem Lohn-eigenen Fehler-Mapping und Revalidate aller drei Oberflächen.
 */
function payrollStaffAction(
  work: () => Promise<Partial<PayrollActionResult> | void>,
): Promise<PayrollActionResult> {
  return staffAction({
    guard: { module: 'payrollIntake', requirePermission: 'PAYROLL_MANAGE' },
    run: work,
    revalidate: PAYROLL_REVALIDATE_PATHS,
    onError: payrollActionError,
  });
}

export interface PayrollEmployerContactsResult {
  ok: boolean;
  error?: string;
  contacts?: Array<{ id: string; fullName: string }>;
}

/**
 * Aktive Kontakte des gewählten Mandats für die Arbeitgeberauswahl. Ersetzt
 * das frühere Vorladen aller Mandate samt aller Kontakte (und die Namenssuche
 * per clients.find je Kontakt). Gleicher Scope wie zuvor: PAYROLL_MANAGE,
 * Modul, Mandantenzugriff, freigegebenes und nicht beendetes Mandat.
 */
export async function loadPayrollEmployerContactsAction(
  clientId: string,
): Promise<PayrollEmployerContactsResult> {
  const parsedClientId = z.uuid().safeParse(clientId);
  if (!parsedClientId.success) return { ok: false, error: 'Ungültiges Mandat.' };
  return staffAction({
    guard: { module: 'payrollIntake', requirePermission: 'PAYROLL_MANAGE' },
    run: async (g) => {
      const contacts = await withTenantContext(g.ctx, async (tx) => {
        await assertClientAccessTx(tx, g.session, parsedClientId.data);
        return tx.clientContact.findMany({
          where: {
            active: true,
            clientId: parsedClientId.data,
            client: { allowActive: true, mandateEndedAt: null },
          },
          select: { id: true, fullName: true },
          orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        });
      });
      return { contacts };
    },
  });
}
export async function createPayrollAction(data: FormData) {
  return payrollStaffAction(async () => ({
    link: '/staff/payroll?id=' + (await createPayroll(data)),
  }));
}
export async function saveEmployerDraftAction(data: FormData) {
  return payrollStaffAction(() => saveEmployer('staff', data));
}
export async function issueEmployeeInviteAction(data: FormData) {
  return payrollStaffAction(async () => ({
    link: await issueEmployeeInvite('staff', data),
    message:
      'Neuer Einmallink erstellt. Frühere Einladungen und ihre Sessions sind widerrufen. Nur der betroffenen Person sicher übermitteln.',
  }));
}
export async function reviewPayrollAction(data: FormData) {
  return payrollStaffAction(() => reviewPayroll(data));
}
export async function confirmPayrollNumbersAction(data: FormData) {
  return payrollStaffAction(() => confirmPayrollNumbers(data));
}
export async function recordImmediateRegistrationAction(data: FormData) {
  return payrollStaffAction(() => recordImmediateRegistration(data));
}
export async function checkDatevGateAction(data: FormData) {
  return payrollStaffAction(async () => ({ message: await checkDatevGate(data) }));
}
export async function createPayrollExportAction(data: FormData) {
  return payrollStaffAction(async () => ({ link: await createPayrollExport(data) }));
}
export async function uploadPayrollAction(data: FormData) {
  return payrollStaffAction(async () => {
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

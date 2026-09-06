import 'server-only';
import { z } from 'zod';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import type { PayrollIntake } from '@prisma/client';
import { staffActionGuard } from '@/server/actions/staff-action';
import { portalActionGuard } from '@/server/actions/portal-action';
import { assertClientAccessTx, ActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  PAYROLL_SCHEMA,
  answerRecord,
  validatePayrollAnswers,
  type PayrollField,
  DATEV_GATE_MESSAGE,
} from './definition';
import { newPayrollToken, tokenHash } from './capability';
import { validWorkflowCalendarDate } from '@/server/workflows/interaction-policy';
import { berlinDayEndUtc } from '@/lib/fmt';
export type PayrollSurface = 'staff' | 'portal';
export async function payrollGuard(surface: PayrollSurface) {
  const g =
    surface === 'staff'
      ? await staffActionGuard({ module: 'payrollIntake', requirePermission: 'PAYROLL_MANAGE' })
      : await portalActionGuard({ module: 'payrollIntake' });
  if (!g.ok) throw new ActionError(g.error);
  return g;
}
export async function payrollTx<T>(
  surface: PayrollSurface,
  id: string,
  fn: (
    tx: TxClient,
    item: PayrollIntake,
    g: Awaited<ReturnType<typeof payrollGuard>>,
  ) => Promise<T>,
): Promise<T> {
  const g = await payrollGuard(surface);
  return withTenantContext(g.ctx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM payroll_intake WHERE id=${id}::uuid FOR UPDATE`;
    const item = await tx.payrollIntake.findUnique({ where: { id } });
    if (!item) throw new ActionError('Personalvorgang nicht verfügbar.');
    if ('staffId' in g) await assertClientAccessTx(tx, g.session, item.clientId);
    else if (g.clientId !== item.clientId) throw new ActionError('Kein Zugriff.');
    const client = await tx.client.findFirst({
      where: {
        id: item.clientId,
        tenantId: g.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
    });
    if (!client) throw new ActionError('Mandat nicht aktiv.');
    return fn(tx, item, g);
  });
}
export async function capturePayrollRevision(tx: TxClient, id: string) {
  await tx.$executeRaw`SELECT app.payroll_capture_authorized_revision(${id}::uuid)`;
}
export function payrollAnswers(data: FormData, fields: PayrollField[]): Record<string, string> {
  return answerRecord.parse(
    Object.fromEntries(fields.map((f) => [f.key, String(data.get(f.key) ?? '')])),
  );
}
function assertEditable(item: PayrollIntake) {
  if (
    !['DRAFT', 'RETURNED'].includes(item.status) ||
    item.revokedAt ||
    item.expiresAt <= new Date()
  )
    throw new ActionError(
      'Vorgang ist nicht mehr bearbeitbar. Für Korrekturen eine Rückgabe anfordern.',
    );
}
export async function createPayroll(data: FormData) {
  const input = z
    .object({
      clientId: z.uuid(),
      contactId: z.uuid(),
      label: z.string().trim().min(2).max(150),
      due: z.string().refine(validWorkflowCalendarDate),
    })
    .parse(Object.fromEntries(data));
  const expiresAt = berlinDayEndUtc(input.due);
  if (!expiresAt || expiresAt <= new Date())
    throw new ActionError('Künftigen Zieltermin auswählen.');
  const g = await payrollGuard('staff');
  return withTenantContext(g.ctx, async (tx) => {
    if (!('staffId' in g)) throw new ActionError('Kanzleizugriff erforderlich.');
    await assertClientAccessTx(tx, g.session, input.clientId);
    const client = await tx.client.findFirst({
      where: { id: input.clientId, allowActive: true, mandateEndedAt: null, anonymizedAt: null },
    });
    const contact = await tx.clientContact.findFirst({
      where: { id: input.contactId, clientId: input.clientId, active: true },
    });
    if (!client || !contact)
      throw new ActionError(
        'Aktives Mandat und ausdrücklich ausgewählter Arbeitgeberkontakt erforderlich.',
      );
    const item = await tx.payrollIntake.create({
      data: {
        tenantId: g.tenantId,
        clientId: client.id,
        employeeLabel: input.label,
        schemaSnapshot: PAYROLL_SCHEMA as object,
        expiresAt,
        createdByStaff: g.staffId,
      },
    });
    await tx.payrollEmployeeData.create({ data: { intakeId: item.id, tenantId: g.tenantId } });
    await tx.payrollEmployerGrant.create({
      data: { tenantId: g.tenantId, intakeId: item.id, contactId: contact.id },
    });
    await tx.payrollExternalTask.create({ data: { tenantId: g.tenantId, intakeId: item.id } });
    await capturePayrollRevision(tx, item.id);
    await evidenceService.record(tx, {
      tenantId: g.tenantId,
      actorType: 'STAFF',
      actorId: g.staffId,
      action: 'payroll.created',
      resourceType: 'payroll_intake',
      resourceId: item.id,
      after: { revision: 0 },
    });
    return item.id;
  });
}
export async function saveEmployer(surface: PayrollSurface, data: FormData) {
  const input = z
    .object({
      id: z.uuid(),
      revision: z.coerce.number().int().nonnegative(),
      submit: z.enum(['0', '1']),
    })
    .parse(Object.fromEntries(data));
  return payrollTx(surface, input.id, async (tx, item) => {
    assertEditable(item);
    if (item.employerConfirmedAt)
      throw new ActionError(
        'Arbeitgeberteil bereits bestätigt. Für Korrekturen Rückgabe anfordern.',
      );
    if (item.revision !== input.revision)
      throw new ActionError('Zwischenzeitlich geändert. Bitte neu laden.');
    const fields = (item.schemaSnapshot as unknown as typeof PAYROLL_SCHEMA).employer;
    const answers = payrollAnswers(data, fields);
    const errors = validatePayrollAnswers('employer', answers, input.submit === '1', fields);
    if (input.submit === '1' && surface !== 'portal')
      errors.push(
        'Die Beschäftigungs-/Vergütungsbestätigung muss vom ausgewählten Arbeitgeberkontakt im Portal erfolgen.',
      );
    if (input.submit === '1' && data.get('confirmed') !== 'on')
      errors.push('Beschäftigungs- und Vergütungsangaben ausdrücklich bestätigen.');
    if (
      input.submit === '1' &&
      (await tx.payrollAttachment.count({
        where: { intakeId: item.id, audience: 'EMPLOYER', status: 'PENDING' },
      })) > 0
    )
      errors.push('Offene Arbeitgeberuploads zuerst abschließen.');
    if (errors.length) throw new ActionError(errors.join(' '));
    await tx.payrollIntake.update({
      where: { id: item.id },
      data: {
        revision: item.revision + 1,
        employerAnswers: answers,
        employerConfirmedAt: input.submit === '1' ? new Date() : null,
        status: input.submit === '1' && item.employeeSubmittedAt ? 'SUBMITTED' : 'DRAFT',
      },
    });
    await capturePayrollRevision(tx, item.id);
  });
}
export async function issueEmployeeInvite(surface: PayrollSurface, data: FormData) {
  const id = z.uuid().parse(data.get('id'));
  return payrollTx(surface, id, async (tx, item, g) => {
    assertEditable(item);
    if (item.employeeSubmittedAt)
      throw new ActionError('Arbeitnehmerangaben bereits eingereicht. Zuerst Korrektur anfordern.');
    await tx.payrollEmployeeInvite.updateMany({
      where: { intakeId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const token = newPayrollToken();
    await tx.payrollEmployeeInvite.create({
      data: {
        tenantId: g.tenantId,
        intakeId: id,
        tokenHash: tokenHash(token),
        expiresAt: item.expiresAt,
      },
    });
    return '/payroll/employee#invite=' + token;
  });
}
export async function reviewPayroll(data: FormData) {
  const input = z
    .object({
      id: z.uuid(),
      revision: z.coerce.number().int(),
      decision: z.enum(['REVIEWED', 'RETURNED', 'REVOKED']),
      note: z.string().trim().min(10).max(1500),
    })
    .parse(Object.fromEntries(data));
  return payrollTx('staff', input.id, async (tx, item, g) => {
    if (item.revision !== input.revision) throw new ActionError('Zwischenzeitlich geändert.');
    if (input.decision === 'REVIEWED' && !['SUBMITTED', 'REVIEWED'].includes(item.status))
      throw new ActionError('Zuerst beide Teile einreichen lassen.');
    if (input.decision === 'RETURNED' && !item.employeeSubmittedAt && !item.employerConfirmedAt)
      throw new ActionError('Noch kein Teil abgegeben.');
    const change =
      input.decision === 'REVOKED'
        ? { revokedAt: new Date() }
        : input.decision === 'RETURNED'
          ? {
              status: 'RETURNED',
              employeeSubmittedAt: null,
              employerConfirmedAt: null,
              reviewedAt: null,
              reviewedByStaff: null,
              reviewNote: input.note,
            }
          : {
              status: 'REVIEWED',
              reviewedAt: new Date(),
              reviewedByStaff: g.ctx.actorId,
              reviewNote: input.note,
            };
    await tx.payrollIntake.update({
      where: { id: item.id },
      data: { ...change, revision: item.revision + 1 },
    });
    await capturePayrollRevision(tx, item.id);
    await evidenceService.record(tx, {
      tenantId: g.tenantId,
      actorType: 'STAFF',
      actorId: g.ctx.actorId,
      action: 'payroll.reviewed',
      resourceType: 'payroll_intake',
      resourceId: item.id,
      after: { revision: item.revision + 1, decision: input.decision },
    });
  });
}
export async function confirmPayrollNumbers(data: FormData) {
  const input = z
    .object({
      id: z.uuid(),
      revision: z.coerce.number().int(),
      advisorNumber: z.string().regex(/^\d{1,7}$/),
      clientNumber: z.string().regex(/^\d{1,7}$/),
      personnelNumber: z.string().regex(/^\d{1,10}$/),
      confirmed: z.literal('on'),
    })
    .parse(Object.fromEntries(data));
  return payrollTx('staff', input.id, async (tx, item) => {
    if (item.revision !== input.revision) throw new ActionError('Zwischenzeitlich geändert.');
    await tx.payrollIntake.update({
      where: { id: item.id },
      data: {
        advisorNumber: input.advisorNumber,
        clientNumber: input.clientNumber,
        personnelNumber: input.personnelNumber,
        numbersConfirmedAt: new Date(),
        revision: item.revision + 1,
        ...(item.status === 'REVIEWED'
          ? { status: 'SUBMITTED', reviewedAt: null, reviewedByStaff: null }
          : {}),
      },
    });
    await capturePayrollRevision(tx, item.id);
  });
}
export async function recordImmediateRegistration(data: FormData) {
  const input = z
    .object({
      id: z.uuid(),
      revision: z.coerce.number().int(),
      status: z.enum(['NOT_REQUIRED', 'EVIDENCE_RECORDED']),
      evidence: z.string().trim().min(10).max(2000),
    })
    .parse(Object.fromEntries(data));
  return payrollTx('staff', input.id, async (tx, item, g) => {
    if (item.revision !== input.revision || item.revokedAt)
      throw new ActionError('Vorgang zwischenzeitlich geändert oder widerrufen.');
    await tx.payrollExternalTask.update({
      where: { intakeId_kind: { intakeId: item.id, kind: 'SOFORTMELDUNG' } },
      data: {
        status: input.status,
        evidence: input.evidence,
        recordedByStaff: g.ctx.actorId,
        recordedAt: new Date(),
      },
    });
    await tx.payrollIntake.update({
      where: { id: item.id },
      data: {
        revision: item.revision + 1,
        ...(item.status === 'REVIEWED'
          ? { status: 'SUBMITTED', reviewedAt: null, reviewedByStaff: null }
          : {}),
      },
    });
    await capturePayrollRevision(tx, item.id);
    await evidenceService.record(tx, {
      tenantId: g.tenantId,
      actorType: 'STAFF',
      actorId: g.ctx.actorId,
      action: 'payroll.external_evidence',
      resourceType: 'payroll_intake',
      resourceId: item.id,
      after: { status: input.status, revision: item.revision + 1 },
    });
  });
}
export async function checkDatevGate(data: FormData) {
  const id = z.uuid().parse(data.get('id'));
  return payrollTx('staff', id, async (tx, item, g) => {
    const blockers = [
      DATEV_GATE_MESSAGE,
      ...(item.status !== 'REVIEWED' ? ['Kanzleiprüfung fehlt.'] : []),
      ...(!item.numbersConfirmedAt
        ? ['Bestätigte Berater-/Mandanten-/Personalnummer fehlen.']
        : []),
    ];
    await tx.payrollExport.create({
      data: {
        tenantId: g.tenantId,
        intakeId: id,
        revision: item.revision,
        kind: 'DATEV_LUG',
        status: 'BLOCKED',
        explanation: blockers.join(' '),
        createdByStaff: g.ctx.actorId!,
      },
    });
    return blockers.join(' ');
  });
}

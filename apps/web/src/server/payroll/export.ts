import 'server-only';
import { payrollPdf, type PayrollSnapshot } from './pdf';
import { z } from 'zod';
import { buildZip, type ZipEntry } from '@/server/export/zip';
import { payrollTx } from './service';
import { persistPayrollFile, payrollFileBytes } from './storage';
import { DATEV_GATE_MESSAGE } from './definition';
import { checkStaffExportLimit } from '@/server/rate-limit';
import { ActionError } from '@/server/actions/action-error';
export async function createPayrollExport(data: FormData) {
  const input = z
    .object({
      id: z.uuid(),
      kind: z.enum(['PDF', 'ZIP']),
      resumeId: z.union([z.uuid(), z.literal('')]).optional(),
    })
    .parse(Object.fromEntries(data));
  const source = await payrollTx('staff', input.id, async (tx, item, g) => {
    if (
      item.status !== 'REVIEWED' ||
      item.revokedAt ||
      !item.employerConfirmedAt ||
      !item.employeeSubmittedAt
    )
      throw new ActionError('Beide Abgaben und Kanzleiprüfung erforderlich.');
    if (!(await checkStaffExportLimit('payroll', g.ctx.actorId!)).ok)
      throw new ActionError('Zu viele Exporte. Bitte später erneut versuchen.');
    const revision = await tx.payrollRevision.findUnique({
      where: { intakeId_revision: { intakeId: item.id, revision: item.revision } },
    });
    if (!revision) throw new ActionError('Prüfstand fehlt.');
    const snapshot = revision.snapshot as unknown as PayrollSnapshot;
    const expected = snapshot.attachments ?? [];
    const attachments = await tx.payrollAttachment.findMany({
      where: { intakeId: item.id, id: { in: expected.map((a) => a.id) }, status: 'COMPLETE' },
    });
    const bound = attachments.filter((a) =>
      expected.some(
        (e) => e.id === a.id && e.sha256 === a.sha256 && e.versionId === a.storageVersionId,
      ),
    );
    if (bound.length !== expected.length)
      throw new ActionError('Anlagenstand stimmt nicht mehr mit der Revision überein.');
    if (bound.reduce((sum, a) => sum + a.sizeBytes, 0n) > 20n * 1024n * 1024n)
      throw new ActionError(
        'ZIP ist auf 20 MiB Quelldateien begrenzt. Anlagen einzeln herunterladen.',
      );
    let exportRow = input.resumeId
      ? await tx.payrollExport.findFirst({
          where: {
            intakeId: item.id,
            revision: item.revision,
            kind: input.kind,
            attachmentId: input.resumeId,
          },
        })
      : null;
    if (input.resumeId && !exportRow)
      throw new ActionError('Upload-ID gehört nicht zu diesem Prüfstand und Exporttyp.');
    if (!exportRow)
      exportRow = await tx.payrollExport.create({
        data: {
          tenantId: g.tenantId,
          intakeId: item.id,
          revision: item.revision,
          kind: input.kind,
          status: 'PENDING',
          explanation: 'Kanzleigeprüfter PDF-/Anlagenstand; keine DATEV-Übertragung.',
          createdByStaff: g.ctx.actorId!,
        },
      });
    return { item, revision, snapshot, attachments: bound, exportRow };
  });
  const makeBytes = async () => {
    const pdf = await payrollPdf({
      label: source.item.employeeLabel,
      revision: source.item.revision,
      createdAt: source.revision.createdAt,
      snapshot: source.snapshot,
    });
    if (input.kind === 'PDF') return pdf;
    const entries: ZipEntry[] = [
      { name: 'personalfragebogen.pdf', data: pdf, modifiedAt: source.revision.createdAt },
    ];
    for (let i = 0; i < source.attachments.length; i++) {
      const a = source.attachments[i]!;
      entries.push({
        name:
          'anlagen/' +
          String(i + 1).padStart(2, '0') +
          '-' +
          a.filename.replace(/[^a-zA-Z0-9._-]/g, '_'),
        data: await payrollFileBytes(a),
        modifiedAt: a.createdAt,
      });
    }
    entries.push({
      name: 'datev-gate.txt',
      data: Buffer.from(DATEV_GATE_MESSAGE),
      modifiedAt: source.revision.createdAt,
    });
    return buildZip(entries);
  };
  const file = await persistPayrollFile({
    surface: 'staff',
    intakeId: input.id,
    artifact: true,
    expectedRevision: source.item.revision,
    filename: 'personalfragebogen-r' + source.item.revision + '.' + input.kind.toLowerCase(),
    bytes: makeBytes,
    ...(input.resumeId ? { resumeId: input.resumeId } : {}),
    onJournal: async (row) => {
      await payrollTx('staff', input.id, async (tx, item) => {
        if (item.revokedAt || item.revision !== source.item.revision || item.status !== 'REVIEWED')
          throw new ActionError('Prüfstand wurde geändert.');
        await tx.payrollExport.update({
          where: { id: source.exportRow.id },
          data: { attachmentId: row.id },
        });
      });
    },
  });
  await payrollTx('staff', input.id, async (tx, item) => {
    if (item.revokedAt || item.revision !== source.item.revision || item.status !== 'REVIEWED')
      throw new ActionError('Prüfstand wurde während der Exporterstellung geändert.');
    if (source.exportRow.status === 'COMPLETE') return;
    const updated = await tx.payrollExport.updateMany({
      where: {
        id: source.exportRow.id,
        intakeId: item.id,
        revision: item.revision,
        status: 'PENDING',
        attachmentId: file.id,
      },
      data: { status: 'COMPLETE' },
    });
    if (updated.count !== 1) throw new ActionError('Export wurde zwischenzeitlich geändert.');
  });
  return '/api/staff/payroll/' + input.id + '/attachments/' + file.id;
}

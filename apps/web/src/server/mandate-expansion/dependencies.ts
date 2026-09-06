// Fachkatalog: WORKFLOW-DEPENDENCY-001
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';

export async function assignWorkflowYearTx(
  tx: TxClient,
  session: StaffSession,
  instanceId: string,
  year: number,
  expectedYear: number | null,
) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200)
    throw new ActionError('Ein Veranlagungsjahr zwischen 1900 und 2200 bestätigen.');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-dependencies:${session.user.tenantId}`},0))`;
  const workflow = await tx.workflowInstance.findFirst({
    where: { id: instanceId, tenantId: session.user.tenantId },
    select: { clientId: true, assessmentYear: true },
  });
  if (!workflow) throw new ActionError('Workflow nicht verfügbar.');
  await assertClientAccessTx(tx, session, workflow.clientId);
  if (workflow.assessmentYear !== expectedYear)
    throw new ActionError('Das Veranlagungsjahr wurde inzwischen geändert. Bitte neu laden.');
  if (workflow.assessmentYear === year) return;
  const connections = await tx.workflowDependency.count({
    where: {
      tenantId: session.user.tenantId,
      OR: [{ predecessor: { instanceId } }, { successor: { instanceId } }],
    },
  });
  if (connections)
    throw new ActionError(
      'Vor einer Änderung des Jahres alle Verbindungen dieses Workflows ausdrücklich entfernen.',
    );
  await tx.workflowInstance.update({ where: { id: instanceId }, data: { assessmentYear: year } });
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'workflow.period.assign',
    resourceType: 'workflow_instance',
    resourceId: instanceId,
    before: { assessmentYear: workflow.assessmentYear },
    after: { assessmentYear: year },
  });
}

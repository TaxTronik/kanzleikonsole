import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError, assertClientAccessTx, accessibleClientsWhereFor } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import {
  StructureSchema,
  structureHash,
  type StructureInput,
  wouldCreateDependencyCycle,
} from './model';

export async function visibleMandatesTx(tx: TxClient, session: StaffSession) {
  return tx.client.findMany({
    where: { AND: [await accessibleClientsWhereFor(tx, session), { anonymizedAt: null }] },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: 1000,
  });
}
export async function loadStructureTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
  versionId?: string,
) {
  await assertClientAccessTx(tx, session, clientId);
  if (
    !(await tx.client.findFirst({
      where: { id: clientId, tenantId: session.user.tenantId, anonymizedAt: null },
      select: { id: true },
    }))
  )
    throw new ActionError('Mandant nicht verfügbar.');
  const version = await tx.mandateStructureVersion.findFirst({
    where: { tenantId: session.user.tenantId, clientId, ...(versionId ? { id: versionId } : {}) },
    include: { nodes: true, edges: true },
    orderBy: { revision: 'desc' },
  });
  if (!version) return null;
  // Full-snapshot read is all-or-nothing. Hidden nodes cannot leak through labels, counts or paths.
  for (const id of new Set(
    version.nodes.flatMap((n) => (n.linkedClientId ? [n.linkedClientId] : [])),
  )) {
    await assertClientAccessTx(tx, session, id);
    if (
      !(await tx.client.findFirst({
        where: { id, tenantId: session.user.tenantId, anonymizedAt: null },
        select: { id: true },
      }))
    )
      throw new ActionError('Verknüpfte Akte nicht verfügbar.');
  }
  const keys = new Map(version.nodes.map((n) => [n.id, n.nodeKey]));
  const input: StructureInput = {
    clientId,
    expectedRevision: version.revision,
    note: version.note,
    nodes: version.nodes.map((n) => ({
      key: n.nodeKey,
      kind: n.kind as StructureInput['nodes'][number]['kind'],
      label: n.label,
      linkedClientId: n.linkedClientId,
      x: n.x,
      y: n.y,
    })),
    edges: version.edges.map((e) => ({
      from: keys.get(e.fromNodeId)!,
      to: keys.get(e.toNodeId)!,
      kind: e.kind as StructureInput['edges'][number]['kind'],
      percentage: e.percentage === null ? null : Number(e.percentage),
      note: e.note,
    })),
  };
  if (structureHash(input) !== version.contentHash)
    throw new ActionError(
      'Der gespeicherte Strukturstand stimmt nicht mit seinem Quellenhash überein. Keine Ausgabe oder Übernahme.',
    );
  return {
    id: version.id,
    revision: version.revision,
    contentHash: version.contentHash,
    createdAt: version.createdAt.toISOString(),
    input,
  };
}
export async function saveStructureTx(tx: TxClient, session: StaffSession, raw: unknown) {
  const parsed = StructureSchema.safeParse(raw);
  if (!parsed.success)
    throw new ActionError(parsed.error.issues[0]?.message ?? 'Ungültige Struktur.');
  const input = parsed.data;
  await assertClientAccessTx(tx, session, input.clientId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mandate-structure:${input.clientId}`},0))`;
  const previous = await loadStructureTx(tx, session, input.clientId);
  if ((previous?.revision ?? 0) !== input.expectedRevision)
    throw new ActionError('Die Struktur wurde inzwischen geändert. Bitte neu laden.');
  for (const node of input.nodes)
    if (node.linkedClientId) {
      await assertClientAccessTx(tx, session, node.linkedClientId);
      const c = await tx.client.findFirst({
        where: { id: node.linkedClientId, tenantId: session.user.tenantId, anonymizedAt: null },
        select: { name: true },
      });
      if (!c) throw new ActionError('Mandant nicht verfügbar.');
      node.label = c.name;
    }
  const hash = structureHash(input);
  const version = await tx.mandateStructureVersion.create({
    data: {
      tenantId: session.user.tenantId,
      clientId: input.clientId,
      revision: input.expectedRevision + 1,
      contentHash: hash,
      note: input.note,
      createdBy: session.user.staffId,
    },
  });
  const nodes = new Map<string, string>();
  for (const node of input.nodes) {
    const row = await tx.mandateStructureNode.create({
      data: {
        tenantId: session.user.tenantId,
        versionId: version.id,
        nodeKey: node.key,
        kind: node.kind,
        label: node.label,
        linkedClientId: node.linkedClientId,
        x: node.x,
        y: node.y,
      },
    });
    nodes.set(node.key, row.id);
  }
  for (const edge of input.edges)
    await tx.mandateStructureEdge.create({
      data: {
        tenantId: session.user.tenantId,
        versionId: version.id,
        fromNodeId: nodes.get(edge.from)!,
        toNodeId: nodes.get(edge.to)!,
        kind: edge.kind,
        percentage: edge.percentage,
        note: edge.note,
      },
    });
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: 'mandate.structure.save',
    resourceType: 'client',
    resourceId: input.clientId,
    after: { revision: version.revision, contentHash: hash },
  });
  return version.id;
}
export async function changeDependencyTx(
  tx: TxClient,
  session: StaffSession,
  from: string,
  to: string,
  remove = false,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-dependencies:${session.user.tenantId}`},0))`;
  const items = await tx.workflowItem.findMany({
    where: { id: { in: [from, to] }, instance: { tenantId: session.user.tenantId } },
    include: { instance: true },
  });
  if (items.length !== 2)
    throw new ActionError('Zwei unterschiedliche Workflow-Schritte auswählen.');
  for (const item of items) await assertClientAccessTx(tx, session, item.instance.clientId);
  if (items[0]!.instance.clientId === items[1]!.instance.clientId)
    throw new ActionError('Diese Verbindung ist für Schritte verschiedener Mandanten vorgesehen.');
  if (remove)
    await tx.workflowDependency.deleteMany({
      where: { tenantId: session.user.tenantId, predecessorItemId: from, successorItemId: to },
    });
  else {
    if (
      items.some((item) => item.instance.assessmentYear === null) ||
      items[0]!.instance.assessmentYear !== items[1]!.instance.assessmentYear
    )
      throw new ActionError(
        'Beide Workflowvorgänge müssen ausdrücklich demselben Veranlagungsjahr zugeordnet sein.',
      );
    const existing = await tx.workflowDependency.findMany({
      where: { tenantId: session.user.tenantId },
      select: { predecessorItemId: true, successorItemId: true },
    });
    if (
      wouldCreateDependencyCycle(
        existing.map((e) => ({ from: e.predecessorItemId, to: e.successorItemId })),
        from,
        to,
      )
    )
      throw new ActionError('Die Abhängigkeit würde einen Zyklus erzeugen.');
    await tx.workflowDependency.createMany({
      data: {
        tenantId: session.user.tenantId,
        predecessorItemId: from,
        successorItemId: to,
        createdBy: session.user.staffId,
      },
      skipDuplicates: true,
    });
  }
  await evidenceService.record(tx, {
    tenantId: session.user.tenantId,
    actorType: 'STAFF',
    actorId: session.user.staffId,
    action: remove ? 'workflow.dependency.remove' : 'workflow.dependency.add',
    resourceType: 'workflow_item',
    resourceId: to,
    after: { predecessorItemId: from, successorItemId: to },
  });
}
export async function loadDependenciesTx(tx: TxClient, session: StaffSession) {
  const clients = await visibleMandatesTx(tx, session);
  const ids = clients.map((c) => c.id);
  const items = await tx.workflowItem.findMany({
    where: { instance: { tenantId: session.user.tenantId, clientId: { in: ids } } },
    include: {
      instance: { select: { clientId: true, name: true, status: true, assessmentYear: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });
  const visibleIds = new Set(items.map((i) => i.id));
  // Never infer readiness by silently dropping a hidden prerequisite.
  const dependencies = await tx.workflowDependency.findMany({
    where: { tenantId: session.user.tenantId, successorItemId: { in: [...visibleIds] } },
    include: {
      predecessor: {
        include: {
          instance: { select: { clientId: true, status: true, name: true, assessmentYear: true } },
        },
      },
    },
  });
  return {
    clients,
    items,
    dependencies: dependencies.filter((d) => visibleIds.has(d.predecessorItemId)),
    blockedTargets: new Set(
      dependencies
        .filter((d) => !visibleIds.has(d.predecessorItemId))
        .map((d) => d.successorItemId),
    ),
  };
}

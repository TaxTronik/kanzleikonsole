// Reproducible, synthetic browser fixtures for apps/e2e/tests/17-expansion.spec.ts.
// They live in the ordinary dev seed so the browser suite never depends on an
// undocumented local database snapshot.
import type { PrismaClient } from '@prisma/client';
import { ensureDevSeedVerifiedGwgCheck } from './lib';

const EXPANSION_MODULES = {
  knowledgeContext: true,
  yearEndCampaigns: true,
  noticeDecisions: true,
  smartMailbox: true,
  payrollIntake: true,
  expenseAssistance: true,
  clientProcedures: true,
  feedbackSurveys: true,
  mandateStructure: true,
  workflowDependencies: true,
  mandateOffboarding: true,
  vdbPreparation: true,
  sanctionsScreening: true,
  feeCalculator: true,
} as const;

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function ensureActiveFixtureClient(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    adminId: string;
    datevNo: string;
    name: string;
  },
) {
  const client = await prisma.client.upsert({
    where: {
      tenantId_datevNo: { tenantId: input.tenantId, datevNo: input.datevNo },
    },
    update: {
      name: input.name,
      kind: 'JURPERS',
      allowActive: false,
      mandateEndedAt: null,
    },
    create: {
      tenantId: input.tenantId,
      kind: 'JURPERS',
      name: input.name,
      datevNo: input.datevNo,
      allowActive: false,
    },
  });

  await ensureDevSeedVerifiedGwgCheck(prisma, {
    tenantId: input.tenantId,
    clientId: client.id,
    verifiedBy: input.adminId,
  });
  await prisma.client.update({ where: { id: client.id }, data: { allowActive: true } });
  await prisma.clientResponsibility.upsert({
    where: {
      clientId_staffId_role: {
        clientId: client.id,
        staffId: input.adminId,
        role: 'HAUPTBEARBEITER',
      },
    },
    update: {},
    create: {
      tenantId: input.tenantId,
      clientId: client.id,
      staffId: input.adminId,
      role: 'HAUPTBEARBEITER',
    },
  });
  return client;
}

async function ensureDependencyWorkflow(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    clientId: string;
    adminId: string;
    name: string;
    itemTitle: string;
  },
) {
  const existing = await prisma.workflowInstance.findFirst({
    where: { tenantId: input.tenantId, clientId: input.clientId, name: input.name },
    orderBy: { startedAt: 'asc' },
  });
  const instance =
    existing ??
    (await prisma.workflowInstance.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        name: input.name,
        assessmentYear: null,
        startedByStaff: input.adminId,
      },
    }));
  const existingItem = await prisma.workflowItem.findFirst({
    where: { instanceId: instance.id, position: 0 },
    orderBy: { createdAt: 'asc' },
  });
  const item =
    existingItem ??
    (await prisma.workflowItem.create({
      data: {
        instanceId: instance.id,
        position: 0,
        title: input.itemTitle,
        assigneeStaffId: input.adminId,
      },
    }));
  return { instance, item };
}

export async function ensureExpansionE2eFixtures(
  prisma: PrismaClient,
  input: { tenantId: string; adminId: string },
): Promise<void> {
  const storedModules = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId: input.tenantId, key: 'modules' } },
    select: { value: true },
  });
  const modules = { ...jsonObject(storedModules?.value), ...EXPANSION_MODULES };
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId: input.tenantId, key: 'modules' } },
    update: { value: modules, updatedBy: input.adminId },
    create: {
      tenantId: input.tenantId,
      key: 'modules',
      value: modules,
      updatedBy: input.adminId,
    },
  });

  const payrollClient = await ensureActiveFixtureClient(prisma, {
    ...input,
    datevNo: '19990',
    name: 'Synthetische Pilot GmbH',
  });
  await prisma.clientContact.upsert({
    where: {
      tenantId_clientId_email: {
        tenantId: input.tenantId,
        clientId: payrollClient.id,
        email: 'synthetischer.lohnkontakt@example.test',
      },
    },
    update: { fullName: 'Synthetischer Lohnkontakt', active: true },
    create: {
      tenantId: input.tenantId,
      clientId: payrollClient.id,
      email: 'synthetischer.lohnkontakt@example.test',
      fullName: 'Synthetischer Lohnkontakt',
      active: true,
      notificationsEnabled: false,
    },
  });

  const sourceClient = await ensureActiveFixtureClient(prisma, {
    ...input,
    datevNo: '19991',
    name: 'Abhängigkeit Quelle',
  });
  const targetClient = await ensureActiveFixtureClient(prisma, {
    ...input,
    datevNo: '19992',
    name: 'Abhängigkeit Ziel',
  });
  const source = await ensureDependencyWorkflow(prisma, {
    ...input,
    clientId: sourceClient.id,
    name: 'Veranlagung Quelle',
    itemTitle: 'Prüfung Quelle',
  });
  const target = await ensureDependencyWorkflow(prisma, {
    ...input,
    clientId: targetClient.id,
    name: 'Veranlagung Ziel',
    itemTitle: 'Prüfung Ziel',
  });
  const fixtureItemIds = [source.item.id, target.item.id];
  await prisma.workflowDependency.deleteMany({
    where: {
      tenantId: input.tenantId,
      OR: [
        { predecessorItemId: { in: fixtureItemIds } },
        { successorItemId: { in: fixtureItemIds } },
      ],
    },
  });
  await prisma.workflowInstance.updateMany({
    where: { id: { in: [source.instance.id, target.instance.id] } },
    data: { assessmentYear: null, status: 'ACTIVE', completedAt: null },
  });
  await prisma.workflowItem.updateMany({
    where: { id: { in: fixtureItemIds } },
    data: { doneAt: null, doneByStaff: null },
  });
}

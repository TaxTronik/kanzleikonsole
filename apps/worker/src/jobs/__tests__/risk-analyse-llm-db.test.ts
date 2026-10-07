// Fachkatalog: RISK-AI-SUGGESTION-001, RISK-ARCHIVE-SNAPSHOT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): risk-analyse-llm über die App-Rolle.
//
// Der Job liest den Sachverhalt unter dem Analyse-Lock, hängt neue
// Markierungen an, setzt llmEnrichedAt und schreibt das Audit-Ereignis im
// SYSTEM-Kontext des Tenants über taxtronik_app (RLS). Engine und Owner-Client
// sind ersetzt; jeder Owner-Zugriff ließe die Suite scheitern. Belegt: dieselben
// Schreibvorgänge wie zuvor (nur neue Markierungen, Zeitstempel, Audit), und
// eine Analyse eines fremden Tenants bleibt unsichtbar und unverändert, auch
// wenn ihre ID im Auftrag steht.
//
// Nur mit ausdrücklichem Opt-in im db-Job (WORKER_DB_TEST=1). Tenant A behält
// seine append-only Audit-Zeile in der Wegwerf-Datenbank; Tenant B wird gelöscht.
// =============================================================================

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertAppRoleConnection,
  assertLoopbackDatabases,
  createStaffFixture,
  createTenantFixture,
  deleteTenantFixtures,
  ownerAccess,
  resetOwnerAccess,
  type Owner,
} from '../../__tests__/app-role-db';

const enabled = process.env['WORKER_DB_TEST'] === '1';
if (enabled) assertLoopbackDatabases('WORKER_DB_TEST');

const engine = vi.hoisted(() => ({
  analyse: async (_input: { text: string }) => ({
    engineVersion: 'engine-test',
    markings: [] as Array<Record<string, unknown>>,
  }),
}));

vi.mock('bullmq', async () => {
  const mock = await import('./mocks/bullmq');
  return { ...mock, UnrecoverableError: class UnrecoverableError extends Error {} };
});
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/risk-layer', () => ({
  RiskLayerClient: class {
    llmStatus = async () => ({ verfuegbar: true });
    llmStart = async () => undefined;
    analyse = (input: { text: string }) => engine.analyse(input);
  },
}));
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const { guardOwnerClient } = await import('../../__tests__/app-role-db');
  return { ...actual, prismaOwner: guardOwnerClient(actual.prismaOwner, []) };
});

import { prisma, withSystemContext } from '@taxtronik/db';
import { processors } from './mocks/bullmq';
import '../risk-analyse-llm';

const describeDb = enabled ? describe : describe.skip;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function marking(begriff: string, herkunft: 'WOERTLICH' | 'LLM', start: number) {
  return {
    start,
    end: start + 4,
    matchedText: begriff,
    herkunft,
    begriffId: null,
    begriff,
    normAnker: [],
    normRefs: [],
    normketten: null,
    governanceTyp: null,
    schadensintensitaet: null,
    wahrscheinlichkeit: null,
    kaskadenreichweite: null,
    engineStatus: 'treffer',
    streitig: false,
  };
}

describeDb('S-01 risk-analyse-llm via the app role', () => {
  let owner: Owner;
  const a = { tenant: '', staff: '', analysis: '', text: 'Sachverhalt A mit Gewerbe' };
  const b = { tenant: '', staff: '', analysis: '', text: 'Sachverhalt B mit Gewerbe' };

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    expect(await assertAppRoleConnection(prisma)).toBe('taxtronik_app');
    for (const [fixture, label] of [
      [a, 'risk-llm-a'],
      [b, 'risk-llm-b'],
    ] as const) {
      fixture.tenant = await createTenantFixture(owner, label);
      fixture.staff = await createStaffFixture(owner, fixture.tenant, { name: label });
      await owner.tenantSetting.create({
        data: { tenantId: fixture.tenant, key: 'modules', value: { risk: true } },
      });
      fixture.analysis = (
        await owner.riskAnalysis.create({
          data: {
            tenantId: fixture.tenant,
            sourceText: fixture.text,
            textHash: sha256(fixture.text),
            katalogVersion: 'katalog-test',
            engineVersion: 'engine-test',
            createdById: fixture.staff,
            markings: {
              create: [
                {
                  tenantId: fixture.tenant,
                  ...marking('Sachverhalt', 'WOERTLICH', 0),
                  normRefs: undefined,
                  normketten: undefined,
                },
              ],
            },
          },
          select: { id: true },
        })
      ).id;
    }
    engine.analyse = async () => ({
      engineVersion: 'engine-test',
      markings: [marking('Sachverhalt', 'WOERTLICH', 0), marking('Gewerbe', 'LLM', 18)],
    });
  });

  afterAll(async () => {
    if (owner) await deleteTenantFixtures(owner, [a.tenant, b.tenant]);
  });

  const run = (data: { tenantId: string; analysisId: string; sourceHash: string }) =>
    processors.get('risk-analyse-llm')!({ data });

  it('ergänzt nur neue Markierungen und auditiert wie bisher, ohne den Owner-Client', async () => {
    resetOwnerAccess();
    await run({ tenantId: a.tenant, analysisId: a.analysis, sourceHash: sha256(a.text) });

    const stored = await owner.riskAnalysis.findUniqueOrThrow({
      where: { id: a.analysis },
      select: {
        llmEnrichedAt: true,
        markings: { select: { begriff: true, herkunft: true }, orderBy: { start: 'asc' } },
      },
    });
    expect(stored.llmEnrichedAt).not.toBeNull();
    expect(stored.markings).toEqual([
      { begriff: 'Sachverhalt', herkunft: 'WOERTLICH' },
      { begriff: 'Gewerbe', herkunft: 'LLM' },
    ]);
    const audit = await owner.auditLog.findMany({
      where: { tenantId: a.tenant, action: 'risk.analysis.llm_enriched' },
      select: { actorType: true, resourceId: true, after: true },
    });
    expect(audit).toEqual([
      {
        actorType: 'SYSTEM',
        resourceId: a.analysis,
        after: { added: 1, total: 2, engineVersion: 'engine-test' },
      },
    ]);
    expect(ownerAccess.denied).toEqual([]);
  });

  it('sieht und ändert die Analyse eines fremden Tenants nicht, auch mit ihrer ID im Auftrag', async () => {
    resetOwnerAccess();
    await run({ tenantId: a.tenant, analysisId: b.analysis, sourceHash: sha256(b.text) });

    const foreign = await owner.riskAnalysis.findUniqueOrThrow({
      where: { id: b.analysis },
      select: { llmEnrichedAt: true, _count: { select: { markings: true } } },
    });
    expect(foreign).toEqual({ llmEnrichedAt: null, _count: { markings: 1 } });
    expect(await owner.auditLog.count({ where: { tenantId: b.tenant } })).toBe(0);
    // RLS: im SYSTEM-Kontext von A ist die Analyse von B unsichtbar.
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.riskAnalysis.findMany({ where: { id: b.analysis } }),
      ),
    ).toEqual([]);
    expect(ownerAccess.denied).toEqual([]);
  });
});

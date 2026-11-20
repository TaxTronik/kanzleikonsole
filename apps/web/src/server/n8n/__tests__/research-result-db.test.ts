// Fachkatalog: ACCESS-TENANT-RLS-001, RISK-EXTERNAL-ANONYMIZATION-001,
// ACCESS-NOTIFICATION-RECIPIENT-001, RISK-ARCHIVE-SNAPSHOT-001
// =============================================================================
// S-01 (Folgearbeit): n8n-Rechercheergebnis (v1-Callback) über die App-Rolle.
//
// Der v1-Callback kennt seinen Tenant aus der Credential-Prüfung. Korrelation,
// Modulschalter, Receipt, Ergebnis, Audit und Hinweis laufen im SYSTEM-Kontext
// dieses Tenants über taxtronik_app (RLS); der Owner-Client ist hier
// vollständig gesperrt. Belegt gegen PostgreSQL: dasselbe gespeicherte Ergebnis
// wie bisher (de-anonymisiert, Titel des Auftrags, Auftrag ANSWERED, Receipt
// mit Ergebnis-ID, Audit und Hinweis), eine Wiederholung bleibt idempotent, und
// eine Korrelations-ID von Tenant B ist für Tenant A nicht zuordenbar, ohne
// dass in einem der beiden Tenants etwas geschrieben wird.
//
// Wie CI: DATABASE_URL ist die Owner-Rolle (nur Fixtures), DATABASE_APP_URL
// die App-Rolle. Nur mit ausdrücklichem Opt-in (N8N_RESEARCH_DB_TEST=1); die
// Tenants behalten ihre append-only Audit-Zeilen in der Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// B-02: lokal per N8N_RESEARCH_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['N8N_RESEARCH_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'N8N_RESEARCH_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`N8N_RESEARCH_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`N8N_RESEARCH_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const owner = vi.hoisted(() => ({ calls: [] as string[] }));

// Jeder Zugriff des Callback-Pfads auf den Owner-Client wird protokolliert und wirft.
vi.mock('@/server/db/prisma-owner', () => ({
  prismaOwner: new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string' || model === 'then') return undefined;
        return new Proxy(
          {},
          {
            get(_delegate, method) {
              if (typeof method !== 'string' || method === 'then') return undefined;
              return () => {
                owner.calls.push(`${model}.${method}`);
                throw new Error(`S-01: Owner-Client für ${model}.${method} benutzt`);
              };
            },
          },
        );
      },
    },
  ),
}));
vi.mock('@/server/container', async () => {
  const { EvidenceService, LocalTimestampAdapter } = await import('@taxtronik/evidence');
  return { evidenceService: new EvidenceService(new LocalTimestampAdapter()) };
});
vi.mock('@/server/n8n/outbox', () => ({ enqueueN8nEvent: vi.fn() }));
// Der Risk-Index zieht UI-/Auth-Module nach; der Callback braucht nur den echten Empfänger.
vi.mock('@/server/risk', async () => {
  const research = await import('@/server/risk/research');
  return { receiveTenantResearchResult: research.receiveTenantResearchResult };
});
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn() }));

import * as db from '@taxtronik/db';
import { N8N_CALLBACK_OPERATIONS } from '@/server/n8n/callback-receipts';
import { receiveResearchResultForTenant } from '../operations';

const { withSystemContext } = db;
// Fixtures legt die echte Owner-Verbindung an (nicht der gesperrte Client des Pfads).
const fixtures = db.prismaOwner;

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 n8n research result via the app role', () => {
  type Fixture = { tenant: string; staff: string; request: string; connection: string };
  const a = {} as Fixture;
  const b = {} as Fixture;

  async function seed(fixture: Fixture, label: string) {
    const suffix = randomUUID();
    fixture.tenant = (
      await fixtures.tenant.create({
        data: { slug: `s01-research-${label}-${suffix}`, name: `S-01 Recherche ${label}` },
      })
    ).id;
    fixture.staff = (
      await fixtures.staffUser.create({
        data: {
          tenantId: fixture.tenant,
          email: `s01-research-${label}-${suffix}@example.test`,
          fullName: `Synthetic ${label}`,
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    await fixtures.tenantSetting.create({
      data: { tenantId: fixture.tenant, key: 'modules', value: { risk: true } },
    });
    const analysis = await fixtures.riskAnalysis.create({
      data: {
        tenantId: fixture.tenant,
        sourceText: 'Synthetischer Sachverhalt',
        textHash: 'a'.repeat(64),
        katalogVersion: 'synthetic',
        engineVersion: 'synthetic',
        createdById: fixture.staff,
      },
    });
    fixture.request = (
      await fixtures.riskResearchRequest.create({
        data: {
          tenantId: fixture.tenant,
          analysisId: analysis.id,
          title: `Recherche ${label}`,
          anonymizedPayload: { text: 'Frage zu [PERSON_1]' },
          mapping: { '[PERSON_1]': `Erika ${label}` },
          createdById: fixture.staff,
        },
      })
    ).id;
    fixture.connection = (
      await fixtures.n8nConnection.create({
        data: { tenantId: fixture.tenant, name: `n8n ${label}` },
      })
    ).id;
  }

  beforeAll(async () => {
    await seed(a, 'a');
    await seed(b, 'b');
    const [role] = await withSystemContext(
      a.tenant,
      (tx) =>
        tx.$queryRaw<Array<{ role: string; bypass: boolean; superuser: boolean }>>`
          SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
            FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ role: 'taxtronik_app', bypass: false, superuser: false });
  });

  const receipt = (fixture: Fixture, requestId: string) => ({
    tenantId: fixture.tenant,
    connectionId: fixture.connection,
    requestId,
    operation: N8N_CALLBACK_OPERATIONS.researchResult,
  });

  it('wertet fehlende und nichtkanonische Ergebnis-IDs ohne Hinweis aus und verwendet ausschließlich App-Rechte', async () => {
    const f = {} as Fixture;
    await seed(f, 'kennungen');
    const actor = { tenantId: f.tenant, actorId: f.staff, actorType: 'STAFF' as const };
    const result = await fixtures.riskResearchResult.create({
      data: {
        id: 'a' + randomUUID().slice(1),
        tenantId: f.tenant,
        researchRequestId: f.request,
        body: 'Synthetische Antwort',
      },
    });
    const rows = await db.withTenantContext(
      actor,
      (tx) => tx.$queryRaw<Array<{ visible: boolean }>>`
      SELECT app.risk_research_notification_visible(${f.tenant}::uuid, candidate, ${f.staff}::uuid) AS visible
      FROM (VALUES (1, ${result.id}::text), (2, NULL::text), (3, ''), (4, 'kein-ergebnis'),
        (5, upper(${result.id}::text)), (6, ${randomUUID()}::text)) ids(position, candidate) ORDER BY position`,
    );
    expect(rows).toEqual([
      { visible: true },
      ...Array.from({ length: 5 }, () => ({ visible: false })),
    ]);
    const [acl] = await db.withTenantContext(
      actor,
      (tx) => tx.$queryRaw<Array<{ definer: boolean; app: boolean; public_execute: boolean }>>`
      SELECT p.prosecdef AS definer,
        has_function_privilege(current_user,p.oid,'EXECUTE') AS app,
        EXISTS (SELECT FROM aclexplode(p.proacl) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc p WHERE oid = 'app.risk_research_notification_visible(uuid,text,uuid)'::regprocedure`,
    );
    expect(acl).toEqual({ definer: false, app: true, public_execute: false });
  });

  it('wendet auf Hinweise zur vertraulichen Analyse im OPEN-Mandat die aktuelle Markierungszuständigkeit an', async () => {
    const f = {} as Fixture;
    await seed(f, 'scope');
    const tenantId = f.tenant;
    const employee = (label: string) =>
      fixtures.staffUser.create({
        data: {
          tenantId,
          email: `${label}-${tenantId}@example.test`,
          fullName: label,
          passwordHash: 'synthetic',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      });
    const first = await employee('Erste');
    const next = await employee('Zweite');
    const client = await fixtures.client.create({
      data: { tenantId, name: 'Synthetisches Mandat', kind: 'NATPERS' },
    });
    await fixtures.tenantSetting.create({
      data: { tenantId, key: 'access', value: { clientAccessMode: 'OPEN' } },
    });
    const { analysisId } = await fixtures.riskResearchRequest.findUniqueOrThrow({
      where: { id: f.request },
    });
    await fixtures.riskAnalysis.update({
      where: { id: analysisId },
      data: { clientId: client.id, vertraulich: true, sourceText: 'A😀B' },
    });
    // Das abschließende B steht bei JavaScript-Offset 3, PostgreSQL zählt drei Unicode-Zeichen.
    const marking = await fixtures.riskMarking.create({
      data: {
        tenantId,
        analysisId,
        start: 3,
        end: 4,
        matchedText: 'B',
        herkunft: 'BERATER',
        begriff: 'Beispiel',
        normAnker: [],
        verantwortlichId: first.id,
      },
    });
    const request = (staffId: string) =>
      fixtures.riskResearchRequest.create({
        data: {
          tenantId,
          analysisId,
          markingId: marking.id,
          title: 'Synthetische Recherche',
          anonymizedPayload: {},
          mapping: {},
          createdById: staffId,
        },
      });
    const deliver = async (id: string) => {
      const callback = await receiveResearchResultForTenant(
        tenantId,
        {
          researchRequestId: id,
          body: 'Synthetische Antwort',
          source: 'Testdienst',
        },
        receipt(f, randomUUID()),
      );
      expect(callback).toEqual({ resultId: expect.any(String), duplicate: false });
      return callback!.resultId;
    };
    const unread = (staffId: string) =>
      db.withTenantContext({ tenantId, actorType: 'STAFF', actorId: staffId }, async (tx) => ({
        badge: await tx.notification.count({ where: { readAt: null } }),
        resources: (
          await tx.notification.findMany({ where: { readAt: null }, select: { resourceId: true } })
        )
          .map((row) => row.resourceId)
          .sort(),
      }));
    const firstRequest = await request(first.id);
    const delayedRequest = await request(first.id);
    const early = await deliver(firstRequest.id);
    expect(await unread(first.id)).toEqual({ badge: 1, resources: [early] });

    await fixtures.riskMarking.update({
      where: { id: marking.id },
      data: { verantwortlichId: next.id },
    });
    const late = await deliver(delayedRequest.id);
    expect(
      await fixtures.riskResearchResult.findUniqueOrThrow({
        where: { id: late },
        select: { status: true, markingId: true },
      }),
    ).toEqual({ status: 'ZUGEORDNET', markingId: marking.id });
    expect(await fixtures.notification.count({ where: { tenantId, resourceId: late } })).toBe(0);
    expect(
      await fixtures.notification.count({
        where: { tenantId, resourceId: early, staffId: first.id },
      }),
    ).toBe(1);
    expect(await unread(first.id)).toEqual({ badge: 0, resources: [] });
    expect(
      await db.withTenantContext({ tenantId, actorType: 'STAFF', actorId: first.id }, (tx) =>
        tx.notification.updateMany({ where: { resourceId: early }, data: { readAt: new Date() } }),
      ),
    ).toEqual({ count: 0 });

    const newResult = await deliver((await request(next.id)).id);
    expect(await unread(next.id)).toEqual({ badge: 1, resources: [newResult] });
    await fixtures.riskMarking.update({ where: { id: marking.id }, data: { start: 4, end: 6 } });
    expect(await unread(next.id)).toEqual({ badge: 0, resources: [] });
    await fixtures.clientResponsibility.create({
      data: { tenantId, clientId: client.id, staffId: next.id, role: 'HAUPTBEARBEITER' },
    });
    expect(await unread(next.id)).toEqual({ badge: 1, resources: [newResult] });
    const adminResult = await deliver(f.request);
    expect(await unread(f.staff)).toEqual({ badge: 1, resources: [adminResult] });
  });

  it('unterscheidet kanzleiweite Eingänge von verwaisten persönlichen Hinweisen und erhält technische Hinweise', async () => {
    const f = {} as Fixture;
    await seed(f, 'eingang');
    const actor = { tenantId: f.tenant, actorId: f.staff, actorType: 'STAFF' as const };
    const deliver = (researchRequestId?: string) =>
      receiveResearchResultForTenant(
        f.tenant,
        {
          ...(researchRequestId ? { researchRequestId } : {}),
          body: 'Synthetische Rückmeldung',
        },
        receipt(f, randomUUID()),
      );
    const personal = await deliver(f.request);
    const broadcast = await deliver();
    const ordinary = await fixtures.notification.create({
      data: {
        tenantId: f.tenant,
        staffId: f.staff,
        title: 'Technische Meldung',
        kind: 'SYSTEM_AUDIT_OK',
      },
    });
    const list = () =>
      db.withTenantContext(actor, (tx) =>
        tx.notification.findMany({ select: { resourceId: true, staffId: true } }),
      );
    expect(await list()).toHaveLength(3);
    await fixtures.riskResearchRequest.delete({ where: { id: f.request } });
    expect(
      await fixtures.riskResearchResult.findUniqueOrThrow({
        where: { id: personal!.resultId },
        select: { researchRequestId: true },
      }),
    ).toEqual({ researchRequestId: null });
    expect(await list()).toEqual(
      expect.arrayContaining([
        { resourceId: broadcast!.resultId, staffId: null },
        { resourceId: null, staffId: f.staff },
      ]),
    );
    expect(await list()).toHaveLength(2);
    expect(
      await db.withTenantContext(actor, (tx) =>
        tx.notification.updateMany({ where: { id: ordinary.id }, data: { readAt: new Date() } }),
      ),
    ).toEqual({ count: 1 });
  });

  it('speichert das korrelierte Ergebnis wie bisher, ohne Owner-Zugriff', async () => {
    owner.calls.length = 0;
    const delivery = `delivery-${randomUUID()}`;
    const first = await receiveResearchResultForTenant(
      a.tenant,
      { researchRequestId: a.request, body: 'Antwort für [PERSON_1]', source: 'n8n' },
      receipt(a, delivery),
    );
    expect(first).toEqual({ resultId: expect.any(String), duplicate: false });

    expect(
      await fixtures.riskResearchResult.findMany({
        where: { tenantId: a.tenant },
        select: { id: true, researchRequestId: true, title: true, body: true, status: true },
      }),
    ).toEqual([
      {
        id: first!.resultId,
        researchRequestId: a.request,
        title: 'Recherche a',
        body: 'Antwort für Erika a',
        status: 'NEU',
      },
    ]);
    expect(
      await fixtures.riskResearchRequest.findUniqueOrThrow({
        where: { id: a.request },
        select: { status: true },
      }),
    ).toEqual({ status: 'ANSWERED' });
    expect(
      await fixtures.n8nCallbackReceipt.findMany({
        where: { tenantId: a.tenant },
        select: { operation: true, resultId: true },
      }),
    ).toEqual([{ operation: 'research-result', resultId: first!.resultId }]);
    expect(
      await fixtures.auditLog.findMany({
        where: { tenantId: a.tenant },
        select: { action: true, actorType: true, resourceId: true },
      }),
    ).toEqual([
      { action: 'risk.research.received', actorType: 'SYSTEM', resourceId: first!.resultId },
    ]);
    expect(
      await fixtures.notification.findMany({
        where: { tenantId: a.tenant },
        select: { staffId: true, resourceId: true },
      }),
    ).toEqual([{ staffId: a.staff, resourceId: first!.resultId }]);

    // Wiederholung desselben Callbacks: gespeichertes Outcome, keine zweite Zeile.
    expect(
      await receiveResearchResultForTenant(
        a.tenant,
        { researchRequestId: a.request, body: 'Antwort für [PERSON_1]', source: 'n8n' },
        receipt(a, delivery),
      ),
    ).toEqual({ resultId: first!.resultId, duplicate: true });
    expect(await fixtures.riskResearchResult.count({ where: { tenantId: a.tenant } })).toBe(1);
    expect(owner.calls).toEqual([]);
  });

  it('ordnet eine Korrelations-ID von Tenant B für Tenant A nicht zu', async () => {
    owner.calls.length = 0;
    const before = await fixtures.riskResearchResult.count({
      where: { tenantId: { in: [a.tenant, b.tenant] } },
    });

    expect(
      await receiveResearchResultForTenant(
        a.tenant,
        { researchRequestId: b.request, body: 'Fremde Antwort', source: 'n8n' },
        receipt(a, `delivery-${randomUUID()}`),
      ),
    ).toBeNull();

    expect(
      await fixtures.riskResearchResult.count({
        where: { tenantId: { in: [a.tenant, b.tenant] } },
      }),
    ).toBe(before);
    expect(
      await fixtures.riskResearchRequest.findUniqueOrThrow({
        where: { id: b.request },
        select: { status: true },
      }),
    ).toEqual({ status: 'SENT' });
    expect(
      await withSystemContext(a.tenant, (tx) =>
        tx.riskResearchRequest.findMany({ where: { id: b.request } }),
      ),
    ).toEqual([]);
    expect(owner.calls).toEqual([]);
  });
});

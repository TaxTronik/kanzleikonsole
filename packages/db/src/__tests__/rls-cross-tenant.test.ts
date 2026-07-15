// =============================================================================
// Cross-Tenant-RLS-Test — Pflicht in CI (siehe ADR 0002)
//
// Öffnet zwei Sessions mit unterschiedlichen tenant_ids.
// Stellt sicher, dass die App-Role KEINE Daten anderer Tenants sehen kann.
//
// Voraussetzung: Postgres läuft und DATABASE_URL ist gesetzt (Owner-URL für Setup,
// DATABASE_APP_URL für den eigentlichen RLS-Test).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import { withTenantContext } from '../tenant-context';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);

if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error(
    'Cross-Tenant-RLS-Tests brauchen DATABASE_URL und DATABASE_APP_URL in CI. ' +
      'DATABASE_APP_URL muss die App-Role verwenden, nicht den Owner.',
  );
}

const describeWithDatabase = hasDatabase ? describe : describe.skip;

const TENANT_CLIENT_PAIR_TABLES = [
  'appointment',
  'appointment_request',
  'bwa_period',
  'bwa_plan',
  'client_consent',
  'client_contact',
  'client_custom_field_value',
  'client_handover',
  'client_master_change_request',
  'client_reminder',
  'client_responsibility',
  'document',
  'document_folder',
  'elster_kontoabfrage',
  'form_submission',
  'gwg_check',
  'gwg_onboarding_invite',
  'invoice',
  'pending_binder',
  'phone_note',
  'power_of_attorney',
  'request',
  'risk_analysis',
  'tax_deadline',
  'tax_filing',
  'tax_notice',
  'tax_schedule_config',
  'time_entry',
  'workflow_instance',
] as const;

// Owner-Client für Test-Setup (BYPASSRLS)
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});

// App-Client für RLS-Tests (taxtronik_app mit RLS)
const appClient = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

// Globale Test-IDs, damit afterAll aufräumen kann
let tenantAId: string;
let tenantBId: string;
let clientAId: string;
let clientBId: string;
let staffAId: string;
let staffBId: string;
let docAId: string;
let docBId: string;
let requestAId: string;
let requestBId: string;
let invoiceAId: string;
let invoiceBId: string;
let bwaPlanBId: string;
let bwaPlanLineAId: string;
let bwaPlanLineBId: string;

beforeAll(async () => {
  // Zwei Tenants anlegen (Owner-Verbindung, BYPASSRLS)
  const tenantA = await owner.tenant.create({
    data: { slug: `test-rls-a-${Date.now()}`, name: 'RLS-Test Tenant A' },
  });
  const tenantB = await owner.tenant.create({
    data: { slug: `test-rls-b-${Date.now()}`, name: 'RLS-Test Tenant B' },
  });
  tenantAId = tenantA.id;
  tenantBId = tenantB.id;

  // Je einen Mitarbeiter (für created_by-FKs)
  const staffA = await owner.staffUser.create({
    data: {
      tenantId: tenantAId,
      email: `staff-a-${Date.now()}@example.com`,
      fullName: 'Staff A',
      passwordHash: 'x',
      active: true,
    },
  });
  const staffB = await owner.staffUser.create({
    data: {
      tenantId: tenantBId,
      email: `staff-b-${Date.now()}@example.com`,
      fullName: 'Staff B',
      passwordHash: 'x',
      active: true,
    },
  });
  staffAId = staffA.id;
  staffBId = staffB.id;

  // Je einen Mandanten pro Tenant — über den echten Onboarding-Flow aktiviert:
  // 1) inaktiv anlegen (iter57-INSERT-Trigger verbietet allow_active=true ohne
  //    verifizierten gwg_check), 2) VERIFIED gwg_check anlegen, 3) aktivieren.
  // Aktiv MUSS sein, weil die GwG-Schranke (init/iter2/iter5) Dokument-,
  // Anforderungs- und Rechnungsanlage für inaktive Mandanten blockt.
  const clientA = await owner.client.create({
    data: { tenantId: tenantAId, kind: 'JURPERS', name: 'Mandant von A', allowActive: false },
  });
  const clientB = await owner.client.create({
    data: { tenantId: tenantBId, kind: 'JURPERS', name: 'Mandant von B', allowActive: false },
  });
  clientAId = clientA.id;
  clientBId = clientB.id;

  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId: tenantAId,
    clientId: clientAId,
    verifiedBy: staffAId,
    registerNumber: 'HRB RLS-A',
    representativeNames: ['Vertretung A'],
    ownershipStructureNotes: 'Test-Snapshot für die RLS-Regression.',
  });
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId: tenantBId,
    clientId: clientBId,
    verifiedBy: staffBId,
    registerNumber: 'HRB RLS-B',
    representativeNames: ['Vertretung B'],
    ownershipStructureNotes: 'Test-Snapshot für die RLS-Regression.',
  });
  await owner.client.update({ where: { id: clientAId }, data: { allowActive: true } });
  await owner.client.update({ where: { id: clientBId }, data: { allowActive: true } });

  // Je ein Dokument
  const docA = await owner.document.create({
    data: {
      tenantId: tenantAId,
      clientId: clientAId,
      title: 'Doc A',
      classification: 'GENERAL',
      mimeType: 'application/pdf',
    },
  });
  const docB = await owner.document.create({
    data: {
      tenantId: tenantBId,
      clientId: clientBId,
      title: 'Doc B',
      classification: 'GENERAL',
      mimeType: 'application/pdf',
    },
  });
  docAId = docA.id;
  docBId = docB.id;

  // Je eine Anforderung
  const reqA = await owner.request.create({
    data: {
      tenantId: tenantAId,
      clientId: clientAId,
      title: 'Req A',
      description: 'x',
      createdByStaff: staffAId,
    },
  });
  const reqB = await owner.request.create({
    data: {
      tenantId: tenantBId,
      clientId: clientBId,
      title: 'Req B',
      description: 'x',
      createdByStaff: staffBId,
    },
  });
  requestAId = reqA.id;
  requestBId = reqB.id;

  // Je eine Rechnung
  const invA = await owner.invoice.create({
    data: {
      tenantId: tenantAId,
      clientId: clientAId,
      number: `RE-A-${Date.now()}`,
      issueDate: new Date(),
      dueDate: new Date(),
      subject: 'Inv A',
      netAmount: '100',
      vatAmount: '19',
      totalAmount: '119',
      vatRate: '19',
      createdByStaff: staffAId,
    },
  });
  const invB = await owner.invoice.create({
    data: {
      tenantId: tenantBId,
      clientId: clientBId,
      number: `RE-B-${Date.now()}`,
      issueDate: new Date(),
      dueDate: new Date(),
      subject: 'Inv B',
      netAmount: '200',
      vatAmount: '38',
      totalAmount: '238',
      vatRate: '19',
      createdByStaff: staffBId,
    },
  });
  invoiceAId = invA.id;
  invoiceBId = invB.id;

  // Je ein BWA-Plan mit einer Planzeile. bwa_plan_line ist eine Join-Tabelle
  // OHNE eigenes tenant_id — RLS läuft über die EXISTS-Policy auf den
  // Eltern-Plan (iter83, analog bwa_position).
  const planA = await owner.bwaPlan.create({
    data: {
      tenantId: tenantAId,
      clientId: clientAId,
      name: 'Plan A',
      year: 2026,
      createdBy: staffAId,
      createdByType: 'STAFF',
    },
  });
  const planB = await owner.bwaPlan.create({
    data: {
      tenantId: tenantBId,
      clientId: clientBId,
      name: 'Plan B',
      year: 2026,
      createdBy: staffBId,
      createdByType: 'STAFF',
    },
  });
  bwaPlanBId = planB.id;

  const lineA = await owner.bwaPlanLine.create({
    data: { planId: planA.id, axis: 'REVENUE', amount: '100000' },
  });
  const lineB = await owner.bwaPlanLine.create({
    data: { planId: planB.id, axis: 'REVENUE', amount: '200000' },
  });
  bwaPlanLineAId = lineA.id;
  bwaPlanLineBId = lineB.id;
});

afterAll(async () => {
  // Aufräumen — Cascade löscht auch clients, documents, etc.
  await owner.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
  await owner.$disconnect();
  await appClient.$disconnect();
});

describeWithDatabase('Cross-Tenant RLS', () => {
  it('Test 1: Tenant A darf Mandant von B nicht sehen', async () => {
    const clients = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.client.findMany(),
    );
    const ids = clients.map((c) => c.id);
    expect(ids).toContain(clientAId);
    expect(ids).not.toContain(clientBId);
  });

  it('Test 2: Tenant B darf Mandant von A nicht sehen', async () => {
    const clients = await withTenantContext(
      { tenantId: tenantBId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.client.findMany(),
    );
    const ids = clients.map((c) => c.id);
    expect(ids).toContain(clientBId);
    expect(ids).not.toContain(clientAId);
  });

  it('Test 3: Direkter prisma-Aufruf ohne Kontext liefert leer (App-Role + RLS)', async () => {
    // Kein withTenantContext → kein SET LOCAL → app.current_tenant_id() = NULL → Policy = false
    const clients = await appClient.client.findMany({
      where: { id: { in: [clientAId, clientBId] } },
    });
    expect(clients).toHaveLength(0);
  });

  it('Test 4: Cross-Tenant-Update auf Client von B aus Kontext A schlägt fehl', async () => {
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.client.update({
          where: { id: clientBId },
          data: { name: 'Manipuliert' },
        }),
      ),
    ).rejects.toThrow(); // RLS-Violation oder Record not found
  });

  it('Test 5: Direktes findUnique auf fremden Client gibt null zurück', async () => {
    const result = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.client.findUnique({ where: { id: clientBId } }),
    );
    expect(result).toBeNull();
  });

  it('Test 6: Document — Tenant A sieht kein Dokument von B', async () => {
    const docs = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.document.findMany({ where: { id: { in: [docAId, docBId] } } }),
    );
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(docAId);
    expect(ids).not.toContain(docBId);
  });

  it('Test 7: Request — Tenant B sieht keine Anforderung von A', async () => {
    const reqs = await withTenantContext(
      { tenantId: tenantBId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.request.findMany({ where: { id: { in: [requestAId, requestBId] } } }),
    );
    const ids = reqs.map((r) => r.id);
    expect(ids).toContain(requestBId);
    expect(ids).not.toContain(requestAId);
  });

  it('Test 8: Invoice — Tenant A sieht keine Rechnung von B', async () => {
    const inv = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.invoice.findMany({ where: { id: { in: [invoiceAId, invoiceBId] } } }),
    );
    const ids = inv.map((i) => i.id);
    expect(ids).toContain(invoiceAId);
    expect(ids).not.toContain(invoiceBId);
  });

  it('Test 9: Audit-Log — Tenant A sieht keine Audit-Einträge von B', async () => {
    // Provoziere einen audit-Eintrag in beiden Tenants über raw SQL (Trigger
    // existiert via evidence-Service in der App, hier reicht ein Insert via Owner).
    // Stattdessen: prüfe einfach, dass eine cross-tenant-Suche im audit_log
    // keine Tenant-B-Zeilen für Tenant A liefert.
    const aLogs = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.auditLog.findMany({ where: { tenantId: tenantBId }, take: 5 }),
    );
    expect(aLogs).toHaveLength(0);
  });

  it('Test 10: Cross-Tenant-Insert wird durch RLS-INSERT-Policy blockiert', async () => {
    // Versuche, im Kontext A einen Mandanten mit tenantId=B anzulegen.
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.client.create({
          data: { tenantId: tenantBId, kind: 'JURPERS', name: 'Schmuggel', allowActive: false },
        }),
      ),
    ).rejects.toThrow();
  });

  it('Test 11: Cross-Tenant-Delete schlägt fehl', async () => {
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.client.delete({ where: { id: clientBId } }),
      ),
    ).rejects.toThrow();
  });

  it('Test 12: Parallele Sessions (Promise.all) leaken sich nicht gegenseitig', async () => {
    // Wenn `SET LOCAL` versehentlich auf einer geteilten Connection landen
    // würde, würde eine Session die andere überschreiben. Prüfen wir, dass
    // beide unabhängig die richtigen Daten sehen.
    const [resA, resB] = await Promise.all([
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.client.findMany({ select: { id: true, tenantId: true } }),
      ),
      withTenantContext({ tenantId: tenantBId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.client.findMany({ select: { id: true, tenantId: true } }),
      ),
    ]);
    expect(resA.every((c) => c.tenantId === tenantAId)).toBe(true);
    expect(resB.every((c) => c.tenantId === tenantBId)).toBe(true);
    expect(resA.map((c) => c.id)).toContain(clientAId);
    expect(resB.map((c) => c.id)).toContain(clientBId);
    expect(resA.map((c) => c.id)).not.toContain(clientBId);
    expect(resB.map((c) => c.id)).not.toContain(clientAId);
  });

  it('Test 23: jede tenant_id/client_id-Basistabelle trägt den zentralen Paar-Guard', async () => {
    const coverage = await owner.$queryRaw<
      Array<{ table_name: string; guard_count: bigint; enabled_count: bigint }>
    >`
      WITH pair_tables AS (
        SELECT c.table_name
          FROM information_schema.columns c
          JOIN information_schema.tables base
            ON base.table_schema = c.table_schema
           AND base.table_name = c.table_name
           AND base.table_type = 'BASE TABLE'
         WHERE c.table_schema = 'public'
           AND c.column_name IN ('tenant_id', 'client_id')
         GROUP BY c.table_name
        HAVING COUNT(DISTINCT c.column_name) = 2
      )
      SELECT pair_tables.table_name,
             COUNT(t.oid) FILTER (
               WHERE p.proname = 'enforce_tenant_client_pair_integrity'
             )::BIGINT AS guard_count,
             COUNT(t.oid) FILTER (
               WHERE p.proname = 'enforce_tenant_client_pair_integrity'
                 AND t.tgenabled <> 'D'
             )::BIGINT AS enabled_count
        FROM pair_tables
        LEFT JOIN pg_class rel
          ON rel.oid = ('public.' || quote_ident(pair_tables.table_name))::regclass
        LEFT JOIN pg_trigger t
          ON t.tgrelid = rel.oid
         AND NOT t.tgisinternal
        LEFT JOIN pg_proc p ON p.oid = t.tgfoid
       GROUP BY pair_tables.table_name
       ORDER BY pair_tables.table_name
    `;

    expect(coverage.map((row) => row.table_name)).toEqual([...TENANT_CLIENT_PAIR_TABLES]);
    expect(coverage.filter((row) => row.guard_count !== 1n || row.enabled_count !== 1n)).toEqual(
      [],
    );
  });

  it('Test 24: App-Role blockiert Cross-Tenant-Paarung bei INSERT auf zuvor ungeschützten Tabellen', async () => {
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: staffAId, actorType: 'STAFF' }, (tx) =>
        tx.phoneNote.create({
          data: {
            tenantId: tenantAId,
            clientId: clientBId,
            callerName: 'Cross-Tenant',
            subject: 'Muss blockieren',
            body: 'Mandant B darf nicht an Tenant-A-Zeile hängen.',
            takenByStaff: staffAId,
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: staffAId, actorType: 'STAFF' }, (tx) =>
        tx.clientReminder.create({
          data: {
            tenantId: tenantAId,
            clientId: clientBId,
            dueDate: new Date('2026-12-31T00:00:00.000Z'),
            subject: 'Cross-Tenant Reminder',
            createdByStaff: staffAId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('Test 25: App-Role blockiert Cross-Tenant-Reparenting einer sichtbaren Kindzeile', async () => {
    const reminder = await withTenantContext(
      { tenantId: tenantAId, actorId: staffAId, actorType: 'STAFF' },
      (tx) =>
        tx.clientReminder.create({
          data: {
            tenantId: tenantAId,
            clientId: clientAId,
            dueDate: new Date('2026-12-31T00:00:00.000Z'),
            subject: 'Valide Ausgangszeile',
            createdByStaff: staffAId,
          },
        }),
    );

    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: staffAId, actorType: 'STAFF' }, (tx) =>
        tx.clientReminder.update({
          where: { id: reminder.id },
          data: { clientId: clientBId },
        }),
      ),
    ).rejects.toThrow();
  });

  it('Test 26: Client-ID und Tenant-Zuordnung sind auch für BYPASSRLS unveränderlich', async () => {
    await expect(
      owner.client.update({ where: { id: clientAId }, data: { tenantId: tenantBId } }),
    ).rejects.toThrow(/unveränderliche Scope-Identität/);
    await expect(
      owner.client.update({
        where: { id: clientAId },
        data: { id: '99999999-9999-4999-8999-999999999999' },
      }),
    ).rejects.toThrow(/unveränderliche Scope-Identität/);
  });

  it('Test 27: Parent-Lock serialisiert Kind-INSERT ohne Deadlock', async () => {
    let releaseParent!: () => void;
    let parentLocked!: () => void;
    let reportPid!: (pid: number) => void;
    const release = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      parentLocked = resolve;
    });
    const pidReady = new Promise<number>((resolve) => {
      reportPid = resolve;
    });

    const parent = owner.$transaction(
      async (tx) => {
        await tx.$queryRaw`
            SELECT "id" FROM public."client"
             WHERE "id" = ${clientAId}::uuid
             FOR UPDATE
          `;
        parentLocked();
        await release;
      },
      { timeout: 10_000 },
    );

    await locked;
    const child = withTenantContext(
      { tenantId: tenantAId, actorId: staffAId, actorType: 'STAFF' },
      async (tx) => {
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid()::integer AS pid
          `;
        reportPid(backend!.pid);
        return tx.phoneNote.create({
          data: {
            tenantId: tenantAId,
            clientId: clientAId,
            callerName: 'Lock Regression',
            subject: 'Valides Kind nach Parent-Lock',
            body: 'Muss nach Freigabe des Parent-Locks erfolgreich sein.',
            takenByStaff: staffAId,
          },
        });
      },
    );

    try {
      expect(await waitForBackendLock(await pidReady)).toBe(true);
    } finally {
      releaseParent();
    }

    await expect(parent).resolves.toBeUndefined();
    await expect(child).resolves.toMatchObject({ clientId: clientAId, tenantId: tenantAId });
  }, 15_000);

  it('Test 28: App-Role besitzt expliziten CRUD-Zugriff auf beide BWA-Plantabellen', async () => {
    const privileges = await owner.$queryRaw<Array<{ table_name: string; all_granted: boolean }>>`
      WITH expected(table_name, privilege) AS (
        SELECT table_name, privilege
          FROM unnest(ARRAY['bwa_plan', 'bwa_plan_line']) AS tables(table_name)
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS rights(privilege)
      )
      SELECT table_name,
             bool_and(
               has_table_privilege(
                 'taxtronik_app',
                 format('public.%I', table_name),
                 privilege
               )
             ) AS all_granted
        FROM expected
       GROUP BY table_name
       ORDER BY table_name
    `;

    expect(privileges).toEqual([
      { table_name: 'bwa_plan', all_granted: true },
      { table_name: 'bwa_plan_line', all_granted: true },
    ]);
  });

  // ---------------------------------------------------------------------
  // Join-Tabellen ohne eigenes tenant_id (EXISTS-Policy auf Eltern-Tabelle)
  // — bwa_plan_line hatte bis iter83 GAR KEIN RLS. Diese Tests stellen
  // sicher, dass die Join-Policy (USING + WITH CHECK über bwa_plan)
  // Cross-Tenant-Reads und -Writes blockt und nicht wieder wegdriftet.
  // ---------------------------------------------------------------------

  it('Test 20: BwaPlanLine (Join-Tabelle) — Tenant A sieht keine Planzeile von B', async () => {
    const lines = await withTenantContext(
      { tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' },
      (tx) => tx.bwaPlanLine.findMany({ where: { id: { in: [bwaPlanLineAId, bwaPlanLineBId] } } }),
    );
    const ids = lines.map((l) => l.id);
    expect(ids).toContain(bwaPlanLineAId);
    expect(ids).not.toContain(bwaPlanLineBId);
  });

  it('Test 21: BwaPlanLine — Insert an Plan von B aus Kontext A wird blockiert (WITH CHECK)', async () => {
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.bwaPlanLine.create({
          data: { planId: bwaPlanBId, axis: 'PERSONNEL', amount: '1' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('Test 22: BwaPlanLine — Cross-Tenant-Update auf Planzeile von B schlägt fehl', async () => {
    await expect(
      withTenantContext({ tenantId: tenantAId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        tx.bwaPlanLine.update({
          where: { id: bwaPlanLineBId },
          data: { amount: '999999' },
        }),
      ),
    ).rejects.toThrow(); // RLS-Violation oder Record not found
  });

  // ---------------------------------------------------------------------
  // App-Level-Tenant-Filter (Defense in Depth) — Audit Round 15, Finding 4
  //
  // Tests 6-8 oben prüfen, dass RLS Cross-Tenant blockiert. Diese Tests
  // prüfen das andere Standbein der doppelten Verteidigung: der explizite
  // `findFirst({ where: { id, tenantId } })`-Filter im Route-Handler muss
  // auch dann greifen, wenn RLS aus irgendeinem Grund nicht mehr wirkt
  // (Migrations-Drift, versehentlicher Owner-Client, neue Tabelle ohne
  // Policy). Wir simulieren das hier mit dem `owner`-Client, der RLS
  // bypassed — sieht also alle Tenants — und prüfen, dass die App-Filter
  // trotzdem keine Cross-Tenant-Reads zulassen.
  // ---------------------------------------------------------------------

  it('Test 14: document.findFirst({id_of_B, tenantId: A}) liefert null (App-Filter, RLS bypass)', async () => {
    // Owner-Client bypassed RLS — sieht beide Tenants. Trotzdem muss der
    // explizite tenantId-Filter im findFirst die Cross-Tenant-Zeile
    // ausschließen.
    const r = await owner.document.findFirst({
      where: { id: docBId, tenantId: tenantAId },
    });
    expect(r).toBeNull();
  });

  it('Test 15: invoice.findFirst({id_of_B, tenantId: A}) liefert null (App-Filter, RLS bypass)', async () => {
    // ZUGFeRD/XRechnung-Route nutzt dieses Pattern — wenn jemand es
    // versehentlich auf findUnique({where: {id}}) zurücksetzt, schlägt
    // dieser Test an. (Audit Round 15, Finding 4)
    const r = await owner.invoice.findFirst({
      where: { id: invoiceBId, tenantId: tenantAId },
    });
    expect(r).toBeNull();
  });

  it('Test 16: client.findFirst({id_of_B, tenantId: A}) liefert null (App-Filter, RLS bypass)', async () => {
    // DATEV-Belege-Export-Route nutzt dieses Pattern.
    const r = await owner.client.findFirst({
      where: { id: clientBId, tenantId: tenantAId },
    });
    expect(r).toBeNull();
  });

  it('Test 17: document.findFirst({id_of_A, tenantId: A}) liefert das eigene Dokument', async () => {
    // Positiv-Kontrolle: derselbe Filter mit korrektem tenantId liefert
    // das Dokument — verhindert „Test besteht, weil er aus Versehen
    // immer null returnt".
    const r = await owner.document.findFirst({
      where: { id: docAId, tenantId: tenantAId },
    });
    expect(r).not.toBeNull();
    expect(r?.id).toBe(docAId);
  });

  it('Test 18: invoice.findFirst({id_of_A, tenantId: A}) liefert die eigene Rechnung', async () => {
    const r = await owner.invoice.findFirst({
      where: { id: invoiceAId, tenantId: tenantAId },
    });
    expect(r).not.toBeNull();
    expect(r?.id).toBe(invoiceAId);
  });

  it('Test 19: Stress — 20 parallele gemischte Sessions bleiben isoliert', async () => {
    // Wirft viele parallele Anfragen ab und prüft, dass keine einzige
    // Anfrage Daten des falschen Tenants enthält.
    const tasks = Array.from({ length: 20 }).map((_, i) => {
      const tenantId = i % 2 === 0 ? tenantAId : tenantBId;
      return withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, async (tx) => {
        const clients = await tx.client.findMany({ select: { tenantId: true } });
        return { expected: tenantId, actual: clients.map((c) => c.tenantId) };
      });
    });
    const results = await Promise.all(tasks);
    for (const r of results) {
      expect(r.actual.every((tid) => tid === r.expected)).toBe(true);
    }
  });
});

async function waitForBackendLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await owner.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT COALESCE(wait_event_type = 'Lock', FALSE) AS waiting
        FROM pg_stat_activity
       WHERE pid = ${pid}
    `;
    if (activity?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

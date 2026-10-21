// =============================================================================
// Angriffsdurchlauf RT3D (kk-tcms-s11 Punkt 1): Aufbewahrung gebundener
// GwG-Belege gegen echtes PostgreSQL (Owner + App-Rolle, RLS, Trigger).
//
// Gegenstand: app.tcms_gwg_evidence_tax_retention_until,
// app.raise_tcms_gwg_evidence_retention, der Trigger der Verknüpfung und die
// Steuerfrist-Klausel in app.assert_gwg_document_destruction_due /
// app.destroy_gwg_document_versions (Migration 20261021150000).
//
// Produktentscheidung (Rey Koxha, 21.10.2026; fachlich ungeprüft): Ein GwG-Beleg,
// auf den ein Verweis des Tax-CMS zeigt oder zeigte, gilt zugleich als
// steuerliche Unterlage und wird erst nach Ablauf BEIDER Fristen vernichtet –
// „auch nach der Freigabe der Verknüpfung“. Der Object-Lock im GwG-Bucket bleibt
// kurz (5 Jahre + 1 Tag, s11 offener Punkt 2); die steuerliche Frist hält allein
// die Datenbank (retention_until und der Claim).
//
// Schutzziele (grün) und ein Befund (rot, scheitert heute) in diesem File:
//   - Die Steuerfrist ist jahresgenau und zeitzonenunabhängig; NULL-created_at
//     (Altbestand) ist an der Spalte ausgeschlossen (NOT NULL).
//   - raise hebt retention_until auf die Steuerfrist und senkt nie.
//   - Ein gebundener (auch freigegebener) Beleg wird vor der Steuerfrist nicht
//     vernichtet.
//   - BEFUND RT3D-K-01: Für einen gebundenen, noch nicht vorgemerkten GwG-Beleg
//     sind created_at und retention_until unter der App-Rolle frei änderbar und
//     die Verknüpfungszeile ist nicht gegen hartes DELETE geschützt; damit lässt
//     sich der Vernichtungs-Claim vor Ablauf der Steuerfrist passieren.
//
//   DB_TESTS=1 (DATABASE_URL + DATABASE_APP_URL) \
//     pnpm exec vitest run --config vitest.db.config.ts \
//       src/__tests__/redteam-gwg-retention-rt3d-db.test.ts
// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
// =============================================================================
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { dbAbgewiesen } from '../testing/db-fehler';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('RT3D-GwG-Aufbewahrung braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const d = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantId = '';
let staffId = '';
let clientId = '';

/** App-Rolle (RLS) mit Staff-Kontext. */
function inApp<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
    return fn(tx);
  });
}

/**
 * Legt einen gebundenen GWG_EVIDENCE-Altbestand an: Dokument + Version (Trigger
 * an) und eine freigegebene EVENT-Verknüpfung (Trigger der Verknüpfung per
 * session_replication_role umgangen, weil er neue GwG-Bindungen abweist).
 */
async function gebundenerBeleg(opts: {
  createdAt: string;
  retentionUntil: string | null;
}): Promise<string> {
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant_id','${tenantId}',true), set_config('app.current_actor_id','${staffId}',true), set_config('app.current_actor_type','STAFF',true)`,
    );
    const docId = randomUUID();
    const versionId = randomUUID();
    await tx.$executeRaw`
      INSERT INTO document(id,tenant_id,client_id,title,classification,mime_type,created_at,retention_until,updated_at)
      VALUES (${docId}::uuid,${tenantId}::uuid,${clientId}::uuid,'Ausweiskopie','GWG_EVIDENCE','image/jpeg',
              ${opts.createdAt}::timestamp, ${opts.retentionUntil}::timestamp, now())`;
    await tx.$executeRaw`
      INSERT INTO document_version(id,document_id,version_no,storage_bucket,storage_key,sha256,size_bytes,immutable,scan_status,created_by_id,created_at)
      VALUES (${versionId}::uuid,${docId}::uuid,1,'gwg',${`gwg/${docId}`},decode(repeat('ab',32),'hex'),10,false,'CLEAN',${staffId}::uuid,now())`;
    // Trigger aus (nur für die GwG-Bindung, wie ein Altbestand vor dem Guard).
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRaw`
      INSERT INTO tcms_document_reference(id,tenant_id,client_id,document_id,document_version_id,sha256,created_by,created_at,released_at,released_by,release_reason,tcms_subject)
      VALUES (${randomUUID()}::uuid,${tenantId}::uuid,${clientId}::uuid,${docId}::uuid,${versionId}::uuid,
              decode(repeat('ab',32),'hex'),${staffId}::uuid, now() - interval '600 days', now() - interval '500 days',
              ${staffId}::uuid,'NOT_ATTACHED','EVENT')`;
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
    return docId;
  });
}

/** Vormerken und vernichten (Staff-Claim), wie die Admin-Aktion. */
function vernichte(docId: string): Promise<unknown> {
  return inApp(async (tx) => {
    await tx.$executeRaw`UPDATE document SET gwg_destruction_requested_at = now(), gwg_destruction_requested_by = ${staffId}::uuid WHERE id = ${docId}::uuid`;
    return tx.$queryRaw`SELECT app.destroy_gwg_document_versions(${docId}::uuid)`;
  });
}

const retentionUntil = (docId: string) =>
  owner.$queryRaw<Array<{ retention_until: Date | null; gwg_destroyed_at: Date | null }>>`
    SELECT retention_until, gwg_destroyed_at FROM document WHERE id = ${docId}::uuid`;

d('RT3D: Aufbewahrung gebundener GwG-Belege', () => {
  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `rt3d-gwg-${suffix}`, name: 'RT3D GwG' } })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Red Team',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    // Mandat 2019 beendet → reguläre 5-Jahres-GwG-Frist ab 2025 abgelaufen.
    clientId = (
      await owner.client.create({
        data: {
          tenantId,
          name: 'Beendet 2019',
          kind: 'JURPERS',
          allowActive: false,
          mandateEndedAt: new Date('2019-06-30T00:00:00Z'),
        },
      })
    ).id;
    await owner.gwgCheck.create({
      data: {
        tenantId,
        clientId,
        status: 'DRAFT',
        legalForm: 'GmbH',
        registerNumber: 'HRB 1',
        registerAuthority: 'AG Test',
        representativeNames: ['Test'],
      },
    });
  }, 60_000);

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  it('Steuerfrist ist jahresgenau (Anlagejahr + 11, 1. Januar) und zeitzonenunabhängig', async () => {
    // timestamp without time zone → keine Umrechnung, egal welche Session-Zeitzone.
    for (const tz of ['UTC', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      const a = await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${tz}'`);
        const r = await tx.$queryRawUnsafe<Array<{ bis: Date }>>(
          `SELECT app.tcms_gwg_evidence_tax_retention_until(TIMESTAMP '2019-12-31 23:30:00') AS bis`,
        );
        return r[0]!.bis.toISOString();
      });
      expect(a, tz).toBe('2030-01-01T00:00:00.000Z');
    }
    // NULL-Eingang bleibt NULL (Altbestand ohne created_at wäre ungeschützt) …
    const nullBis = await owner.$queryRaw<Array<{ bis: Date | null }>>`
      SELECT app.tcms_gwg_evidence_tax_retention_until(NULL::timestamp) AS bis`;
    expect(nullBis[0]!.bis).toBeNull();
  });

  it('created_at ist NOT NULL – „Altbestand ohne created_at“ ist an der Spalte ausgeschlossen', async () => {
    // Die Steuerklausel liest d.created_at; wäre es NULL, bliebe
    // tcms_gwg_evidence_tax_retention_until NULL und die Klausel (now < NULL)
    // würde übersprungen. Die Spalte schließt das aus.
    const [spalte] = await owner.$queryRaw<Array<{ is_nullable: string }>>`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'document' AND column_name = 'created_at'`;
    expect(spalte!.is_nullable).toBe('NO');
  });

  it('raise hebt retention_until auf die Steuerfrist und senkt nie', async () => {
    const docId = await gebundenerBeleg({ createdAt: '2020-05-01', retentionUntil: '2025-06-01' });
    const [angehoben] = await inApp(
      (tx) =>
        tx.$queryRaw<Array<{ raise_tcms_gwg_evidence_retention: number }>>`
          SELECT app.raise_tcms_gwg_evidence_retention(${docId}::uuid)`,
    );
    expect(angehoben!.raise_tcms_gwg_evidence_retention).toBe(1);
    expect((await retentionUntil(docId))[0]!.retention_until?.toISOString()).toBe(
      '2031-01-01T00:00:00.000Z',
    );
    // Nochmaliges raise senkt nicht (idempotent).
    await inApp((tx) => tx.$queryRaw`SELECT app.raise_tcms_gwg_evidence_retention(${docId}::uuid)`);
    expect((await retentionUntil(docId))[0]!.retention_until?.toISOString()).toBe(
      '2031-01-01T00:00:00.000Z',
    );
  });

  it('Steuerklausel: gebundener (freigegebener) Beleg wird vor der Steuerfrist nicht vernichtet', async () => {
    // retention_until in der Vergangenheit (Object-Lock abgelaufen), Anlage 2020 →
    // Steuerfrist 2031: allein die Steuerklausel muss die Vernichtung sperren.
    const docId = await gebundenerBeleg({ createdAt: '2020-05-01', retentionUntil: '2026-06-01' });
    await dbAbgewiesen(vernichte(docId), { meldung: /steuerliche Unterlage/ });
    expect((await retentionUntil(docId))[0]!.gwg_destroyed_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // BEFUND RT3D-K-01 (scheitert heute): Die Steuerfrist hängt an den unter der
  // App-Rolle frei änderbaren Spalten created_at/retention_until und an einer
  // nicht DELETE-geschützten Verknüpfungszeile. Solange der Beleg nicht
  // vorgemerkt ist (erst dann friert der Guard beide Spalten ein), kann der
  // Aufrufer sie vor dem Vormerken umschreiben und so den SECURITY-DEFINER-Claim
  // vor Ablauf der Steuerfrist passieren – der Object-Lock backstoppt nicht.
  // --------------------------------------------------------------------------
  it('BEFUND RT3D-K-01: created_at + retention_until unter der App-Rolle gesenkt → Vernichtung vor Steuerfrist', async () => {
    const docId = await gebundenerBeleg({ createdAt: '2020-05-01', retentionUntil: '2025-06-01' });
    await inApp((tx) => tx.$queryRaw`SELECT app.raise_tcms_gwg_evidence_retention(${docId}::uuid)`);
    // Noch nicht vorgemerkt → Guard friert created_at/retention_until nicht ein.
    await inApp(
      (tx) =>
        tx.$executeRaw`UPDATE document SET created_at = '2010-01-01', retention_until = '2015-01-01' WHERE id = ${docId}::uuid`,
    );
    // Schutzziel: trotz Manipulation darf vor der Steuerfrist nicht vernichtet werden.
    await dbAbgewiesen(vernichte(docId), { sqlState: '23514' });
    expect((await retentionUntil(docId))[0]!.gwg_destroyed_at).toBeNull();
  });

  // Teil-Entwarnung: Der EXISTS-Anker der Steuerklausel ist gegen hartes DELETE
  // geschützt, weil die App-Rolle kein DELETE auf tcms_document_reference hat
  // (nur INSERT/SELECT/UPDATE). Sonst entfiele die Steuerklausel mit der Zeile.
  it('Verknüpfungszeile: App-Rolle darf nicht hart löschen (DELETE verweigert) – EXISTS-Anker bleibt', async () => {
    const docId = await gebundenerBeleg({ createdAt: '2020-05-01', retentionUntil: '2025-06-01' });
    await dbAbgewiesen(
      inApp(
        (tx) =>
          tx.$executeRaw`DELETE FROM tcms_document_reference WHERE document_id = ${docId}::uuid`,
      ),
      { sqlState: '42501' },
    );
    const zeilen = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM tcms_document_reference WHERE document_id = ${docId}::uuid`;
    expect(Number(zeilen[0]!.n)).toBe(1);
  });
});

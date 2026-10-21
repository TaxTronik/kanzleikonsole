// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
// =============================================================================
// RT3D-K-01 (kk-tcms-fix5, Migration 20261021171000): Die Fristen eines
// GwG-Belegs mit Verweis des Tax-CMS lassen sich ab der ersten Bindung von
// keiner Rolle mehr senken. Jede Regel hat hier einen eigenen Test, der nur an
// ihr scheitert, jeweils für App-Rolle (RLS), Owner-Rolle (taxtronik_owner,
// BYPASSRLS) und Superuser; dazu die Gegenprobe ohne Verweis:
//   - document_tcms_retention_guard: created_at und tenant_id eines Dokuments
//     mit Verweis unveränderlich; ein GwG-Beleg mit Verweis bleibt GwG-Beleg
//     und bei seinem Mandanten; sein Aufbewahrungsende sinkt nie, wird nie NULL,
//     ein fehlendes ersetzt nur ein Ende ab der Steuerfrist;
//   - tcms_document_reference_no_delete: Verweise löscht keine Rolle (außer
//     Tenant-Kaskade und kontrollierter Vernichtung);
//   - client_tcms_gwg_evidence_retention: Das Mandatsende hebt das
//     Aufbewahrungsende auf die GwG-Frist; ein späteres Zurücknehmen oder
//     Vordatieren verkürzt es nicht;
//   - document_tcms_gwg_evidence_retention: Ein freigegebener Nachweis, der
//     zum GwG-Beleg wird, bekommt die Steuerfrist;
//   - Datenschritt der Migration (Altbestand samt GwG-Frist, idempotent);
//   - gwg_object_lock_extension (Migration 20261021171200, Stand des
//     verlängerten Object-Locks je Objektversion): nur für den Worker (keine
//     Rechte der App-Rolle), jede CHECK-Bedingung einzeln, RLS je Tenant.
// Den Angriff selbst hält redteam-gwg-retention-rt3d-db.test.ts fest, die
// Vernichtung samt freigegebener Verweise tcms-document-reference-guards.test.ts.
// Datenbankfehler prüft die gemeinsame Prüfhilfe (testing/db-fehler.ts).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { dbAbgewiesen, type DbErwartung } from '../testing/db-fehler';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('RT3D-K-01 braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

// Superuser (wie im db-Job): Fixtures, Owner-Rolle über SET ROLE, abgeschaltete Trigger.
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
// App-Rolle unter RLS.
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

type Rolle = 'App-Rolle' | 'Owner-Rolle' | 'Superuser';
const ROLLEN: readonly Rolle[] = ['App-Rolle', 'Owner-Rolle', 'Superuser'];

let tenantId = '';
let staffId = '';
/** Mandat 2019 beendet (GwG-Frist 1.1.2025). */
let mandant = '';
/** Zweiter Mandant (Ziel eines Mandantenwechsels). */
let andererMandant = '';

/** Transaktion in der Rolle `rolle` im Tenant (Staff-Kontext). */
async function als<T>(rolle: Rolle, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const client = rolle === 'App-Rolle' ? app : owner;
  return client.$transaction(async (tx) => {
    if (rolle === 'Owner-Rolle') await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_owner');
    await tx.$queryRaw`
      SELECT set_config('app.current_tenant_id', ${tenantId}, true),
             set_config('app.current_actor_id', ${staffId}, true),
             set_config('app.current_actor_type', 'STAFF', true)`;
    return fn(tx as unknown as TxClient);
  }) as Promise<T>;
}

class Rueckrollen extends Error {}

/** Superuser-Transaktion, die immer zurückgerollt wird. */
async function zurueckgerollt(fn: (tx: TxClient) => Promise<unknown>): Promise<void> {
  try {
    await owner.$transaction(async (tx) => {
      await fn(tx as unknown as TxClient);
      throw new Rueckrollen();
    });
  } catch (fehler) {
    if (!(fehler instanceof Rueckrollen)) throw fehler;
  }
}

async function aktiverMandant(name: string, mandateEndedAt: Date | null): Promise<string> {
  const id = (
    await owner.client.create({ data: { tenantId, kind: 'JURPERS', name, allowActive: false } })
  ).id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId,
    clientId: id,
    verifiedBy: staffId,
    registerNumber: `HRB-RT3D-${randomUUID()}`,
  });
  await owner.client.update({ where: { id }, data: { allowActive: true, mandateEndedAt } });
  return id;
}

/** Dokument mit einer sauberen Version (Anlage 2019: Steuerfrist 1.1.2030). */
async function dokument(
  classification: 'GENERAL' | 'GWG_EVIDENCE',
  daten: { createdAt?: Date; retentionUntil?: Date | null; clientId?: string } = {},
) {
  const doc = await owner.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
      set_config('app.current_actor_id', ${staffId}, true),
      set_config('app.current_actor_type', 'STAFF', true)`;
    return tx.document.create({
      data: {
        tenantId,
        clientId: daten.clientId ?? mandant,
        title: classification === 'GENERAL' ? 'Kreditorenliste' : 'Ausweiskopie',
        classification,
        mimeType: 'application/pdf',
        retentionUntil:
          daten.retentionUntil === undefined
            ? new Date('2025-01-01T00:00:00Z')
            : daten.retentionUntil,
        createdAt: daten.createdAt ?? new Date('2019-01-15T00:00:00Z'),
      },
    });
  });
  const version = await owner.documentVersion.create({
    data: {
      documentId: doc.id,
      versionNo: 1,
      storageBucket: classification === 'GENERAL' ? 'general' : 'gwg',
      storageKey: `tenants/${tenantId}/${doc.id}.pdf`,
      storageVersionId: 'v1',
      sha256: Buffer.alloc(32, 0x5c),
      sizeBytes: 812n,
      immutable: classification !== 'GENERAL',
      scanStatus: 'CLEAN',
      scanCompletedAt: new Date(),
      createdById: staffId,
    },
  });
  return { id: doc.id, versionId: version.id, clientId: doc.clientId! };
}

/** Offene Verknüpfung über den Guard (App-Rolle im Tenant), nur für Nicht-GwG-Dokumente. */
async function binden(d: { id: string; versionId: string; clientId: string }): Promise<string> {
  return als(
    'App-Rolle',
    async (tx) =>
      (
        await tx.tcmsDocumentReference.create({
          data: {
            tenantId,
            clientId: d.clientId,
            documentId: d.id,
            documentVersionId: d.versionId,
            sha256: Buffer.alloc(32, 0x5c),
            tcmsSubject: 'EXECUTION',
            tcmsExecutionId: 'cmvfrt3dfix5',
            createdBy: staffId,
          },
        })
      ).id,
  );
}

async function freigeben(verknuepfung: string): Promise<void> {
  await als('App-Rolle', (tx) =>
    tx.tcmsDocumentReference.update({
      where: { id: verknuepfung },
      data: { releasedAt: new Date(), releasedBy: staffId, releaseReason: 'REMOVED' },
    }),
  );
}

/** Freigegebene Verknüpfung eines GwG-Belegs wie vor RT3B-K-01 (Altbestand, nur im Replikationsmodus). */
async function altbestandBinden(d: { id: string; versionId: string; clientId: string }) {
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`
      INSERT INTO tcms_document_reference
        (tenant_id, client_id, document_id, document_version_id, sha256,
         tcms_subject, tcms_execution_id, tcms_evidence_id, created_by,
         released_at, released_by, release_reason)
      VALUES (${tenantId}::uuid, ${d.clientId}::uuid, ${d.id}::uuid,
              ${d.versionId}::uuid, ${Buffer.alloc(32, 0x5c)},
              'EXECUTION', 'cmvfaltbestand', ${`nw${randomUUID().replaceAll('-', '')}`},
              ${staffId}::uuid, now(), ${staffId}::uuid, 'REMOVED')`;
  });
}

/** Gebundener GwG-Beleg (Altbestand), Aufbewahrung wie die Migration angehoben. */
async function gebundenerBeleg(
  daten: { createdAt?: Date; retentionUntil?: Date | null; clientId?: string } = {},
) {
  const d = await dokument('GWG_EVIDENCE', daten);
  await altbestandBinden(d);
  await owner.$queryRaw`SELECT app.raise_tcms_gwg_evidence_retention(${d.id}::uuid)`;
  return d;
}

async function stand(id: string) {
  return owner.document.findUniqueOrThrow({
    where: { id },
    select: {
      createdAt: true,
      retentionUntil: true,
      tenantId: true,
      clientId: true,
      classification: true,
    },
  });
}

function aendern(rolle: Rolle, id: string, set: string): Promise<number> {
  // Feste Spaltenzuweisungen aus diesem Test; die ID ist eine UUID.
  return als(rolle, (tx) => tx.$executeRawUnsafe(`UPDATE document SET ${set} WHERE id = '${id}'`));
}

const gesperrt = (meldung: string): DbErwartung => ({
  sqlState: '23001',
  meldung: new RegExp(`^document: ${meldung}$`),
});
const ANLAGE = gesperrt('Verweis des Tax-CMS, Anlagedatum unveränderlich');
const TENANT = gesperrt('Verweis des Tax-CMS, Tenantwechsel gesperrt');
const KLASSE = gesperrt('GwG-Beleg mit Verweis des Tax-CMS, Umklassifizieren gesperrt');
const MANDANT = gesperrt('GwG-Beleg mit Verweis des Tax-CMS, Mandantenwechsel gesperrt');
const NIE_FRUEHER = gesperrt('GwG-Beleg mit Verweis des Tax-CMS, Aufbewahrungsende nie früher');
const VOR_STEUERFRIST = gesperrt(
  'GwG-Beleg mit Verweis des Tax-CMS, Aufbewahrungsende vor der Steuerfrist',
);
const STEUERFRIST_2019 = new Date('2030-01-01T00:00:00Z');

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = randomUUID();
  tenantId = (await owner.tenant.create({ data: { slug: `rt3d-fix5-${seed}`, name: 'RT3D fix5' } }))
    .id;
  staffId = (
    await owner.staffUser.create({
      data: {
        tenantId,
        email: `rt3d-fix5-${seed}@example.test`,
        fullName: 'Ada Admin',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  mandant = await aktiverMandant('Altmandant GmbH', new Date('2019-06-30T00:00:00Z'));
  andererMandant = await aktiverMandant('Möwe GmbH', null);
}, 60_000);

// Der Tenant bleibt stehen (wie in tcms-document-reference-guards.test.ts): Unveränderliche
// Versionen der GwG-Belege lassen sich nicht löschen, auch nicht in der Kaskade.
afterAll(async () => {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('RT3D-K-01: Fristen gebundener GwG-Belege in der Datenbank', () => {
  it('created_at eines Dokuments mit Verweis ist für jede Rolle unveränderlich (offen, freigegeben, GwG-Beleg)', async () => {
    const offen = await dokument('GENERAL');
    await binden(offen);
    const frei = await dokument('GENERAL');
    await freigeben(await binden(frei));
    const beleg = await gebundenerBeleg();
    for (const d of [offen, frei, beleg]) {
      for (const rolle of ROLLEN) {
        await dbAbgewiesen(
          aendern(rolle, d.id, `created_at = '2010-01-01'`),
          ANLAGE,
          `${rolle} ${d.id}`,
        );
      }
      expect((await stand(d.id)).createdAt).toEqual(new Date('2019-01-15T00:00:00Z'));
      // Unverändert zugewiesen: kein Wechsel, keine Ablehnung.
      await expect(aendern('App-Rolle', d.id, `created_at = '2019-01-15 00:00:00'`)).resolves.toBe(
        1,
      );
    }
    // Gegenprobe: ohne Verweis bleibt die Spalte frei.
    const ohne = await dokument('GWG_EVIDENCE');
    await expect(aendern('App-Rolle', ohne.id, `created_at = '2010-01-01'`)).resolves.toBe(1);
  });

  it('tenant_id eines Dokuments mit freigegebenem Verweis ist für jede Rolle unveränderlich', async () => {
    const frei = await dokument('GENERAL');
    await freigeben(await binden(frei));
    const fremd = (
      await owner.tenant.create({
        data: { slug: `rt3d-fix5-fremd-${randomUUID()}`, name: 'RT3D fix5 fremd' },
      })
    ).id;
    try {
      // Der Trigger läuft vor der Policy (WITH CHECK der App-Rolle).
      for (const rolle of ROLLEN) {
        await dbAbgewiesen(
          aendern(rolle, frei.id, `tenant_id = '${fremd}', client_id = NULL`),
          TENANT,
          rolle,
        );
      }
      expect(await stand(frei.id)).toMatchObject({ tenantId, clientId: mandant });
      // Gegenprobe ohne Verweis (zurückgerollt): der Trigger greift nicht.
      const ohne = await dokument('GENERAL');
      await zurueckgerollt(async (tx) => {
        expect(
          await tx.$executeRaw`UPDATE document SET tenant_id = ${fremd}::uuid, client_id = NULL WHERE id = ${ohne.id}::uuid`,
        ).toBe(1);
      });
    } finally {
      await owner.tenant.delete({ where: { id: fremd } });
    }
  });

  it('ein GwG-Beleg mit Verweis bleibt GwG-Beleg und bei seinem Mandanten (jede Rolle)', async () => {
    const beleg = await gebundenerBeleg();
    for (const rolle of ROLLEN) {
      await dbAbgewiesen(aendern(rolle, beleg.id, `classification = 'GENERAL'`), KLASSE, rolle);
      await dbAbgewiesen(
        aendern(rolle, beleg.id, `client_id = '${andererMandant}'`),
        MANDANT,
        rolle,
      );
    }
    expect(await stand(beleg.id)).toMatchObject({
      classification: 'GWG_EVIDENCE',
      clientId: mandant,
    });
    // Gegenprobe: ein freigegebener allgemeiner Nachweis wechselt den Mandanten
    // (kk-tcms-s10nach), ein GwG-Beleg ohne Verweis die Klasse.
    const frei = await dokument('GENERAL');
    await freigeben(await binden(frei));
    await expect(aendern('App-Rolle', frei.id, `client_id = '${andererMandant}'`)).resolves.toBe(1);
    const ohne = await dokument('GWG_EVIDENCE');
    await expect(aendern('App-Rolle', ohne.id, `classification = 'GENERAL'`)).resolves.toBe(1);
  });

  it('das Aufbewahrungsende eines GwG-Belegs mit Verweis sinkt nie und wird nie NULL; Anheben bleibt erlaubt', async () => {
    const beleg = await gebundenerBeleg();
    expect((await stand(beleg.id)).retentionUntil).toEqual(STEUERFRIST_2019);
    for (const rolle of ROLLEN) {
      await dbAbgewiesen(
        aendern(rolle, beleg.id, `retention_until = '2029-12-31 23:59:59'`),
        NIE_FRUEHER,
        `${rolle}: früher`,
      );
      await dbAbgewiesen(
        aendern(rolle, beleg.id, `retention_until = NULL`),
        NIE_FRUEHER,
        `${rolle}: NULL`,
      );
    }
    expect((await stand(beleg.id)).retentionUntil).toEqual(STEUERFRIST_2019);
    // Gleich und später: erlaubt (jede Rolle).
    await expect(aendern('App-Rolle', beleg.id, `retention_until = '2030-01-01'`)).resolves.toBe(1);
    await expect(aendern('Owner-Rolle', beleg.id, `retention_until = '2031-01-01'`)).resolves.toBe(
      1,
    );
    await expect(aendern('Superuser', beleg.id, `retention_until = '2032-01-01'`)).resolves.toBe(1);
    expect((await stand(beleg.id)).retentionUntil).toEqual(new Date('2032-01-01T00:00:00Z'));
    // Gegenprobe: ohne Verweis bleibt das Ende frei.
    const ohne = await dokument('GWG_EVIDENCE');
    await expect(aendern('App-Rolle', ohne.id, `retention_until = NULL`)).resolves.toBe(1);
  });

  it('ein fehlendes Aufbewahrungsende ersetzt nur ein Ende ab der Steuerfrist', async () => {
    const beleg = await gebundenerBeleg({ retentionUntil: null });
    expect((await stand(beleg.id)).retentionUntil).toBeNull();
    for (const rolle of ROLLEN) {
      await dbAbgewiesen(
        aendern(rolle, beleg.id, `retention_until = '2029-12-31 23:59:59'`),
        VOR_STEUERFRIST,
        rolle,
      );
    }
    // NULL bleibt NULL (fail closed), ein Ende ab der Steuerfrist ist ein Anheben.
    await expect(aendern('App-Rolle', beleg.id, `retention_until = NULL`)).resolves.toBe(1);
    await expect(aendern('App-Rolle', beleg.id, `retention_until = '2030-01-01'`)).resolves.toBe(1);
    expect((await stand(beleg.id)).retentionUntil).toEqual(STEUERFRIST_2019);
  });

  it('Verweise löscht keine Rolle; nur die Tenant-Kaskade und die kontrollierte Vernichtung', async () => {
    const beleg = await gebundenerBeleg();
    const nieGeloescht: DbErwartung = {
      sqlState: '23001',
      meldung: /^tcms_document_reference: ein Verweis wird nie gelöscht, nur freigegeben$/,
    };
    const loeschen = (rolle: Rolle) =>
      als(
        rolle,
        (tx) =>
          tx.$executeRaw`DELETE FROM tcms_document_reference WHERE document_id = ${beleg.id}::uuid`,
      );
    await dbAbgewiesen(loeschen('App-Rolle'), { sqlState: '42501' }, 'App-Rolle (Rechte)');
    await dbAbgewiesen(loeschen('Owner-Rolle'), nieGeloescht, 'Owner-Rolle');
    await dbAbgewiesen(loeschen('Superuser'), nieGeloescht, 'Superuser');
    // Der Vernichtungskontext ist an den Eigentümer der Vernichtungsfunktion
    // gebunden: Die Owner-Rolle kann ihn nicht vortäuschen.
    await dbAbgewiesen(
      als('Owner-Rolle', async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.gwg_destroy_document_id', ${beleg.id}, true)`;
        return tx.$executeRaw`DELETE FROM tcms_document_reference WHERE document_id = ${beleg.id}::uuid`;
      }),
      nieGeloescht,
      'Owner-Rolle mit vorgetäuschtem Vernichtungskontext',
    );
    expect(await owner.tcmsDocumentReference.count({ where: { documentId: beleg.id } })).toBe(1);

    // Tenant-Kaskade: ein eigener Tenant mit gebundenem Beleg lässt sich löschen.
    const kaskade = (
      await owner.tenant.create({
        data: { slug: `rt3d-fix5-kaskade-${randomUUID()}`, name: 'RT3D fix5 Kaskade' },
      })
    ).id;
    const dok = randomUUID();
    const version = randomUUID();
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`
        INSERT INTO document (id, tenant_id, title, classification, mime_type, updated_at)
        VALUES (${dok}::uuid, ${kaskade}::uuid, 'Kreditorenliste', 'GENERAL', 'application/pdf', now())`;
      await tx.$executeRaw`
        INSERT INTO document_version
          (id, document_id, version_no, storage_bucket, storage_key, sha256, size_bytes,
           scan_status, created_by_id)
        VALUES (${version}::uuid, ${dok}::uuid, 1, 'general', ${`tenants/${kaskade}/${dok}.pdf`},
                ${Buffer.alloc(32, 0x5c)}, 812, 'CLEAN', ${staffId}::uuid)`;
      await tx.$executeRaw`
        INSERT INTO tcms_document_reference
          (tenant_id, client_id, document_id, document_version_id, sha256,
           tcms_subject, tcms_execution_id, created_by)
        VALUES (${kaskade}::uuid, ${mandant}::uuid, ${dok}::uuid, ${version}::uuid,
                ${Buffer.alloc(32, 0x5c)}, 'EXECUTION', 'cmvfkaskade', ${staffId}::uuid)`;
    });
    await owner.tenant.delete({ where: { id: kaskade } });
    expect(await owner.tcmsDocumentReference.count({ where: { tenantId: kaskade } })).toBe(0);
  });

  it('das Mandatsende hebt das Aufbewahrungsende auf die GwG-Frist; Zurücknehmen oder Vordatieren verkürzt nicht', async () => {
    const laufend = await aktiverMandant('Laufend GmbH', null);
    const beleg = await gebundenerBeleg({ clientId: laufend });
    expect((await stand(beleg.id)).retentionUntil).toEqual(STEUERFRIST_2019);
    // Nicht betroffen: allgemeiner Nachweis und GwG-Beleg ohne Verweis desselben Mandanten.
    const allgemein = await dokument('GENERAL', { clientId: laufend });
    await binden(allgemein);
    const ohne = await dokument('GWG_EVIDENCE', { clientId: laufend });
    const mandatsende = (wert: string | null) =>
      als(
        'App-Rolle',
        (tx) =>
          tx.$executeRaw`UPDATE client SET mandate_ended_at = ${wert}::timestamptz WHERE id = ${laufend}::uuid`,
      );

    // Mandatsende 15.3.2026 → GwG-Frist 1.1.2032 (später als die Steuerfrist 2030).
    await mandatsende('2026-03-15T10:00:00Z');
    expect((await stand(beleg.id)).retentionUntil).toEqual(new Date('2032-01-01T00:00:00Z'));
    // Vordatiert, zurückgenommen und erneut früh gesetzt: bleibt.
    await mandatsende('2015-01-01T00:00:00Z');
    await mandatsende(null);
    await mandatsende('2016-06-30T00:00:00Z');
    expect((await stand(beleg.id)).retentionUntil).toEqual(new Date('2032-01-01T00:00:00Z'));
    // Ein späteres Ende hebt weiter an; Jahreswechsel nach deutschem Kalender
    // (31.12.2027 23:30 UTC ist in Deutschland schon 2028) → 1.1.2034.
    await mandatsende('2027-12-31T23:30:00Z');
    expect((await stand(beleg.id)).retentionUntil).toEqual(new Date('2034-01-01T00:00:00Z'));
    for (const d of [allgemein, ohne]) {
      expect((await stand(d.id)).retentionUntil).toEqual(new Date('2025-01-01T00:00:00Z'));
    }
  });

  it('ein freigegebener Nachweis, der zum GwG-Beleg wird, bekommt die Steuerfrist', async () => {
    const frei = await dokument('GENERAL');
    await freigeben(await binden(frei));
    await expect(aendern('App-Rolle', frei.id, `classification = 'GWG_EVIDENCE'`)).resolves.toBe(1);
    expect((await stand(frei.id)).retentionUntil).toEqual(STEUERFRIST_2019);
    // Ohne Verweis: unverändert.
    const ohne = await dokument('GENERAL');
    await aendern('App-Rolle', ohne.id, `classification = 'GWG_EVIDENCE'`);
    expect((await stand(ohne.id)).retentionUntil).toEqual(new Date('2025-01-01T00:00:00Z'));
  });

  it('der Datenschritt der Migration 20261021171000 hebt den Altbestand samt GwG-Frist an (idempotent)', async () => {
    const migration = readFileSync(
      new URL(
        '../../prisma/migrations/20261021171000_tcms_gwg_evidence_retention_lock/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const datenschritt = migration.slice(
      migration.indexOf('DO $migration$'),
      migration.lastIndexOf('$migration$;') + '$migration$;'.length,
    );
    expect(datenschritt).toMatch(/^DO \$migration\$[\s\S]+\$migration\$;$/);
    // Mandatsende 2027 (Mandant ohne Trigger gesetzt, wie vor der Migration).
    const spaet = await aktiverMandant('Spät GmbH', null);
    const beleg = await dokument('GWG_EVIDENCE', { clientId: spaet });
    await altbestandBinden(beleg);
    const ohne = await dokument('GWG_EVIDENCE', { clientId: spaet });
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.$executeRaw`UPDATE client SET mandate_ended_at = '2027-05-01T00:00:00Z' WHERE id = ${spaet}::uuid`;
    });
    await owner.$executeRawUnsafe(datenschritt);
    await owner.$executeRawUnsafe(datenschritt);
    expect((await stand(beleg.id)).retentionUntil).toEqual(new Date('2033-01-01T00:00:00Z'));
    expect((await stand(ohne.id)).retentionUntil).toEqual(new Date('2025-01-01T00:00:00Z'));
  });
});

describeWithDatabase('gwg_object_lock_extension (RT3D-K-01, nur für den Worker)', () => {
  async function zeile(daten: Record<string, unknown> = {}) {
    const d = await dokument('GWG_EVIDENCE');
    return {
      documentVersionId: d.versionId,
      tenantId,
      retainUntil: new Date('2030-01-01T00:00:00Z'),
      ...daten,
    };
  }

  it('die App-Rolle hat keine Rechte (lesen, anlegen)', async () => {
    const rechte: DbErwartung = {
      sqlState: '42501',
      meldung: 'permission denied for table gwg_object_lock_extension',
    };
    await dbAbgewiesen(
      als('App-Rolle', (tx) => tx.$queryRaw`SELECT 1 FROM gwg_object_lock_extension`),
      rechte,
      'lesen',
    );
    const z = await zeile();
    await dbAbgewiesen(
      als('App-Rolle', (tx) => tx.gwgObjectLockExtension.create({ data: z })),
      rechte,
      'anlegen',
    );
    // Die Owner-Rolle (Worker) legt an.
    await expect(
      als('Owner-Rolle', (tx) => tx.gwgObjectLockExtension.create({ data: z })),
    ).resolves.toMatchObject({ documentVersionId: z.documentVersionId, failedAttempts: 0 });
  });

  it('CHECK-Bedingungen, jede für sich (NULL erfüllt keine Bedingung still)', async () => {
    const faelle: Array<[Record<string, unknown>, string]> = [
      [{ failedAttempts: -1 }, 'gwg_object_lock_extension_fehler_check'],
      [{ failedAttempts: 1 }, 'gwg_object_lock_extension_fehler_check'],
      [
        { failedAttempts: 1, failedSince: new Date(), lastError: null },
        'gwg_object_lock_extension_fehler_check',
      ],
      [
        { failedAttempts: 0, failedSince: new Date(), lastError: 'AccessDenied' },
        'gwg_object_lock_extension_fehler_check',
      ],
      [{ lastError: 'AccessDenied' }, 'gwg_object_lock_extension_fehler_check'],
      [
        { failedAttempts: 1, failedSince: new Date(), lastError: 'Access Denied' },
        'gwg_object_lock_extension_last_error_check',
      ],
      [
        { failedAttempts: 1, failedSince: new Date(), lastError: 'A'.repeat(65) },
        'gwg_object_lock_extension_last_error_check',
      ],
    ];
    for (const [daten, constraint] of faelle) {
      const z = await zeile(daten);
      await dbAbgewiesen(
        owner.gwgObjectLockExtension.create({ data: z }),
        { sqlState: '23514', meldung: `violates check constraint "${constraint}"` },
        JSON.stringify(daten),
      );
    }
    // Gültig: Erfolg ohne Fehlerangaben, Fehlschlag mit allen drei.
    await expect(
      owner.gwgObjectLockExtension.create({
        data: await zeile({
          retainUntil: null,
          failedAttempts: 2,
          failedSince: new Date(),
          lastError: 'OBJECT_LOCK_EXTEND_UNVERIFIED',
        }),
      }),
    ).resolves.toMatchObject({ failedAttempts: 2 });
  });

  it('RLS: eine Rolle ohne BYPASSRLS sieht und schreibt nur den eigenen Tenant', async () => {
    const eigen = await zeile();
    await owner.gwgObjectLockExtension.create({ data: eigen });
    const fremd = (
      await owner.tenant.create({
        data: { slug: `rt3d-fix5-rls-${randomUUID()}`, name: 'RT3D fix5 RLS' },
      })
    ).id;
    try {
      await zurueckgerollt(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.$executeRawUnsafe(
          'GRANT SELECT, INSERT, UPDATE ON gwg_object_lock_extension TO taxtronik_app',
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
        const sichtbar = async (tenant: string) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`;
          const [z] = await tx.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*)::bigint AS n FROM gwg_object_lock_extension
             WHERE document_version_id = ${eigen.documentVersionId}::uuid`;
          return Number(z!.n);
        };
        expect(await sichtbar(tenantId), 'eigener Tenant').toBe(1);
        expect(await sichtbar(fremd), 'fremder Tenant').toBe(0);
        await dbAbgewiesen(
          tx.$executeRaw`INSERT INTO gwg_object_lock_extension (document_version_id, tenant_id)
                         VALUES (${eigen.documentVersionId}::uuid, ${tenantId}::uuid)`,
          {
            sqlState: '42501',
            meldung:
              'new row violates row-level security policy for table "gwg_object_lock_extension"',
          },
        );
      });
    } finally {
      await owner.tenant.delete({ where: { id: fremd } });
    }
  });
});

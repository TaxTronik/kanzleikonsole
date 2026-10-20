// Fachkatalog: TCMS-NACHWEIS-001, MAIL-OUTBOX-001, ACCESS-TENANT-RLS-001
// =============================================================================
// Schutzregeln der Tax-CMS-Tabellen in PostgreSQL, jede für sich geprüft
// (TCMS Stufe 3, kk-tcms-qual).
//
// tcms_document_reference (Nachweise einer Durchführung, Anlagen einer
// Meldung), tcms_systemakteur und tcms_nachricht_zustellung (Zustell-Worker)
// tragen Trigger, CHECK-Bedingungen, RLS-Policies und Rechte. Jede Regel hat
// hier einen Test, der nur an ihr scheitert:
//   - Ablehnungen über `dbAbgewiesen` (SQLSTATE und Meldung der Datenbank, nie
//     die Prisma-Meldung mit Codeausschnitt);
//   - CHECK-Bedingungen, die ein Trigger vorher abfängt, mit abgeschalteten
//     Triggern (`session_replication_role = replica`, nur Superuser);
//   - die Policies der Worker-Tabellen, auf die weder die App-Rolle (keine
//     Rechte) noch der Owner (BYPASSRLS) trifft, über eine Rolle ohne
//     BYPASSRLS mit vorübergehenden Rechten.
// Alles mit abgeschalteten Triggern oder geliehenen Rechten läuft in einer
// Transaktion, die immer zurückgerollt wird.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';
import { dbAbgewiesen, type DbErwartung } from '../testing/db-fehler';
import { createVerifiedLegalEntityGwgFixture } from './gwg-test-fixture';

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('TCMS-Schutzregeln brauchen DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

// Superuser (wie im db-Job): Fixtures, abgeschaltete Trigger, geliehene Rollen.
const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
// App-Rolle unter RLS.
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

const DURCHF = 'cmvf9pzy3003jfu7d4oo44g6s';

let tenantA = '';
let tenantB = '';
let staffA = '';
let staffB = '';
let mandantA = '';
let mandantA2 = '';
let mandantB = '';
let typA = '';
let typB = '';

class Rueckrollen extends Error {}

/** Superuser-Transaktion, die immer zurückgerollt wird; Fehler darin werden durchgereicht. */
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

/** Wie `zurueckgerollt`, aber ohne Trigger (CHECK-Bedingungen und RLS allein). */
function ohneTrigger(fn: (tx: TxClient) => Promise<unknown>): Promise<void> {
  return zurueckgerollt(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await fn(tx);
  });
}

/**
 * Als App-Rolle (ohne BYPASSRLS) mit vorübergehenden Rechten und
 * abgeschalteten Triggern im Tenant `tenant`: nur die Policy entscheidet.
 */
function alsAppNurPolicy(
  tenant: string,
  rechte: string,
  fn: (tx: TxClient) => Promise<unknown>,
): Promise<void> {
  return ohneTrigger(async (tx) => {
    await tx.$executeRawUnsafe(rechte);
    await tx.$executeRawUnsafe('SET LOCAL ROLE taxtronik_app');
    await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`;
    await fn(tx);
  });
}

/** Transaktion der App-Rolle im Tenant (wie withTenantContext). */
function alsApp<T>(tenant: string, staff: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.current_tenant_id', ${tenant}, true),
             set_config('app.current_actor_id', ${staff}, true),
             set_config('app.current_actor_type', 'STAFF', true)`;
    return fn(tx as unknown as TxClient);
  }) as Promise<T>;
}

async function aktiverMandant(tenant: string, staff: string, name: string): Promise<string> {
  const id = (
    await owner.client.create({
      data: { tenantId: tenant, kind: 'JURPERS', name, allowActive: false },
    })
  ).id;
  await createVerifiedLegalEntityGwgFixture(owner, {
    tenantId: tenant,
    clientId: id,
    verifiedBy: staff,
    registerNumber: `HRB-TCMS-${randomUUID()}`,
  });
  await owner.client.update({ where: { id }, data: { allowActive: true } });
  return id;
}

interface DokumentOptionen {
  tenant?: string;
  mandant?: string;
  classification?: 'GENERAL' | 'PERSONNEL';
  requiresPayrollAccess?: boolean;
  /** `abgeschlossen`: Scan abgeschlossen (Standard: nur bei CLEAN). */
  versionen?: Array<{
    scanStatus: 'CLEAN' | 'PENDING' | 'INFECTED';
    byte: number;
    abgeschlossen?: boolean;
  }>;
}

/** Dokument mit Versionen (Standard: eine saubere Version, SHA-256 aus `byte`). */
async function dokument(o: DokumentOptionen = {}) {
  const tenant = o.tenant ?? tenantA;
  const doc = await owner.document.create({
    data: {
      tenantId: tenant,
      clientId: o.mandant ?? mandantA,
      title: 'Kontoabstimmung',
      classification: o.classification ?? 'GENERAL',
      documentTypeId: tenant === tenantA ? typA : typB,
      mimeType: 'application/pdf',
      requiresPayrollAccess: o.requiresPayrollAccess ?? false,
    },
  });
  const versionen: string[] = [];
  for (const [i, v] of (o.versionen ?? [{ scanStatus: 'CLEAN' as const, byte: 7 }]).entries()) {
    versionen.push(
      (
        await owner.documentVersion.create({
          data: {
            documentId: doc.id,
            versionNo: i + 1,
            storageBucket: 'general',
            storageKey: `tenants/${tenant}/none/${doc.id}-${i}.bin`,
            sha256: Buffer.alloc(32, v.byte),
            sizeBytes: 100n,
            immutable: false,
            scanStatus: v.scanStatus,
            scanCompletedAt: (v.abgeschlossen ?? v.scanStatus === 'CLEAN') ? new Date() : null,
            createdById: tenant === tenantA ? staffA : staffB,
          },
        })
      ).id,
    );
  }
  return { id: doc.id, versionen, mandant: o.mandant ?? mandantA, tenant };
}

type Dokument = Awaited<ReturnType<typeof dokument>>;

/** Daten eines gültigen Verweises (Durchführung) auf die neueste Version von `d`. */
function verweis(d: Dokument, byte = 7, weiteres: Record<string, unknown> = {}) {
  return {
    tenantId: d.tenant,
    clientId: d.mandant,
    documentId: d.id,
    documentVersionId: d.versionen[d.versionen.length - 1]!,
    sha256: Buffer.alloc(32, byte),
    tcmsSubject: 'EXECUTION',
    tcmsExecutionId: DURCHF,
    createdBy: d.tenant === tenantA ? staffA : staffB,
    ...weiteres,
  };
}

async function verknuepft(d: Dokument, weiteres: Record<string, unknown> = {}): Promise<string> {
  return (await owner.tcmsDocumentReference.create({ data: verweis(d, 7, weiteres) })).id;
}

const pruefung = (meldung: string): DbErwartung => ({ sqlState: '23514', meldung });
const checkVerletzt = (constraint: string): DbErwartung => ({
  sqlState: '23514',
  meldung: `violates check constraint "${constraint}"`,
});

beforeAll(async () => {
  if (!hasDatabase) return;
  const [rolle] = await owner.$queryRaw<Array<{ superuser: string }>>`
    SELECT current_setting('is_superuser') AS superuser`;
  if (rolle?.superuser !== 'on') {
    throw new Error('TCMS-Schutzregeln brauchen als DATABASE_URL den Superuser (wie im db-Job).');
  }
  const neu = async (name: string) =>
    (await owner.tenant.create({ data: { slug: `tcms-regeln-${randomUUID()}`, name } })).id;
  tenantA = await neu('TCMS Regeln A');
  tenantB = await neu('TCMS Regeln B');
  const person = async (tenant: string) =>
    (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `tcms-regeln-${randomUUID()}@example.test`,
          fullName: 'Leon Brandt',
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'EMPLOYEE' }] },
        },
      })
    ).id;
  staffA = await person(tenantA);
  staffB = await person(tenantB);
  mandantA = await aktiverMandant(tenantA, staffA, 'Talwind Outdoor GmbH');
  mandantA2 = await aktiverMandant(tenantA, staffA, 'Seestern GmbH');
  mandantB = await aktiverMandant(tenantB, staffB, 'Fremd GmbH');
  const typ = async (tenant: string) =>
    (
      await owner.documentType.create({
        data: { tenantId: tenant, name: 'Allgemein', tier: 'NONE', classificationKey: 'GENERAL' },
      })
    ).id;
  typA = await typ(tenantA);
  typB = await typ(tenantB);
}, 120_000);

afterAll(async () => {
  if (hasDatabase) {
    for (const id of [tenantA, tenantB].filter(Boolean)) {
      await owner.tenant.delete({ where: { id } });
    }
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('tcms_document_reference (TCMS-NACHWEIS-001)', () => {
  it('Trigger bei der Anlage: nur offen', async () => {
    const d = await dokument();
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({
        data: verweis(d, 7, {
          releasedAt: new Date(),
          releasedBy: staffA,
          releaseReason: 'REMOVED',
        }),
      }),
      pruefung('tcms_document_reference: ein neuer Verweis ist nicht freigegeben'),
    );
  });

  it('Trigger bei der Anlage: nur ein verfügbares Dokument genau dieses Mandanten', async () => {
    const nichtVerfuegbar = pruefung(
      'tcms_document_reference: Dokument dieses Mandanten nicht verfügbar',
    );
    const fremd = await dokument({ mandant: mandantA2 });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: { ...verweis(fremd), clientId: mandantA } }),
      nichtVerfuegbar,
    );
    const geloescht = await dokument();
    await owner.document.update({
      where: { id: geloescht.id },
      data: { deletedAt: new Date(), deletedByStaff: staffA },
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: verweis(geloescht) }),
      nichtVerfuegbar,
    );
    const personal = await dokument({ classification: 'PERSONNEL' });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: verweis(personal) }),
      nichtVerfuegbar,
    );
    const lohn = await dokument({ requiresPayrollAccess: true });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: verweis(lohn) }),
      nichtVerfuegbar,
    );
    // Gegenprobe: dasselbe Dokument mit passendem Mandanten wird verknüpft.
    await expect(verknuepft(await dokument())).resolves.toBeTruthy();
  });

  it('Trigger bei der Anlage: nur die neueste, saubere Version mit genau diesem SHA-256', async () => {
    const falscheVersion = pruefung(
      'tcms_document_reference: nur die neueste, saubere Version mit diesem SHA-256',
    );
    const zwei = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 3 },
        { scanStatus: 'CLEAN', byte: 4 },
      ],
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({
        data: verweis(zwei, 3, { documentVersionId: zwei.versionen[0] }),
      }),
      falscheVersion,
    );
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: verweis(zwei, 9) }),
      falscheVersion,
    );
    const ungescannt = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 1 },
        { scanStatus: 'PENDING', byte: 2 },
      ],
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: verweis(ungescannt, 2) }),
      falscheVersion,
    );
    // Gleicher Inhalt in zwei Versionen: nur die Versions-ID unterscheidet.
    const gleich = await dokument({
      versionen: [
        { scanStatus: 'CLEAN', byte: 5 },
        { scanStatus: 'CLEAN', byte: 5 },
      ],
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({
        data: verweis(gleich, 5, { documentVersionId: gleich.versionen[0] }),
      }),
      falscheVersion,
    );
    // Scan abgeschlossen, aber nicht sauber; sauber, aber ohne Abschluss.
    for (const neueste of [
      { scanStatus: 'INFECTED' as const, byte: 6, abgeschlossen: true },
      { scanStatus: 'CLEAN' as const, byte: 6, abgeschlossen: false },
    ]) {
      const d = await dokument({ versionen: [neueste] });
      await dbAbgewiesen(
        owner.tcmsDocumentReference.create({ data: verweis(d, 6) }),
        falscheVersion,
        JSON.stringify(neueste),
      );
    }
    await expect(
      owner.tcmsDocumentReference.create({ data: verweis(zwei, 4) }),
    ).resolves.toBeTruthy();
  });

  it('Trigger bei Änderungen: Bezug und Inhalt unveränderlich', async () => {
    const d = await dokument();
    const id = await verknuepft(d);
    const unveraenderlich = pruefung(
      'tcms_document_reference: Bezug und Inhalt sind unveränderlich',
    );
    const aendern = (data: Record<string, unknown>) =>
      owner.tcmsDocumentReference.update({ where: { id }, data });
    const anderes = await dokument();
    for (const data of [
      { sha256: Buffer.alloc(32, 1) },
      { documentId: anderes.id, documentVersionId: anderes.versionen[0] },
      { tcmsExecutionId: 'anderedurchfuehrung' },
      { createdBy: randomUUID() },
      { createdAt: new Date(0) },
    ]) {
      await dbAbgewiesen(aendern(data), unveraenderlich, JSON.stringify(Object.keys(data)));
    }
    // Der Bezug (Durchführung ↔ Ereignis) ist ebenso fest; der CHECK greift erst danach.
    await dbAbgewiesen(aendern({ tcmsSubject: 'EVENT', tcmsExecutionId: null }), unveraenderlich);
    const anlage = await verknuepft(await dokument(), {
      tcmsSubject: 'EVENT',
      tcmsExecutionId: null,
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.update({
        where: { id: anlage },
        data: { tcmsSubject: 'EXECUTION' },
      }),
      unveraenderlich,
    );
  });

  it('Trigger bei Änderungen: Nachweis-ID und Ereignis-ID einmal, Freigabe endgültig', async () => {
    const d = await dokument();
    const id = await verknuepft(d);
    const aendern = (data: Record<string, unknown>) =>
      owner.tcmsDocumentReference.update({ where: { id }, data });
    const nachweisEinmal = pruefung(
      'tcms_document_reference: die Nachweis-ID wird nur einmal gesetzt',
    );
    await expect(aendern({ tcmsEvidenceId: 'nachweisaaa1' })).resolves.toBeTruthy();
    await dbAbgewiesen(aendern({ tcmsEvidenceId: 'nachweisbbb2' }), nachweisEinmal);
    await dbAbgewiesen(aendern({ tcmsEvidenceId: null }), nachweisEinmal);
    await expect(
      aendern({ releasedAt: new Date(), releasedBy: staffA, releaseReason: 'REMOVED' }),
    ).resolves.toBeTruthy();
    const endgueltig = pruefung('tcms_document_reference: eine Freigabe ist endgültig');
    await dbAbgewiesen(
      aendern({ releasedAt: null, releasedBy: null, releaseReason: null }),
      endgueltig,
    );
    await dbAbgewiesen(aendern({ releaseReason: 'NOT_ATTACHED' }), endgueltig);

    // Nach der Freigabe wird keine Nachweis-ID mehr nachgetragen.
    const offen = await verknuepft(await dokument());
    await owner.tcmsDocumentReference.update({
      where: { id: offen },
      data: { releasedAt: new Date(), releasedBy: staffA, releaseReason: 'NOT_ATTACHED' },
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.update({
        where: { id: offen },
        data: { tcmsEvidenceId: 'nachweisccc3' },
      }),
      nachweisEinmal,
    );

    // Meldungsanlage (EVENT): Ereignis-ID einmal, auch nicht nach der Freigabe.
    const ereignisEinmal = pruefung(
      'tcms_document_reference: die Ereignis-ID wird nur einmal gesetzt',
    );
    const anlage = await verknuepft(await dokument(), {
      tcmsSubject: 'EVENT',
      tcmsExecutionId: null,
    });
    const anlageAendern = (data: Record<string, unknown>) =>
      owner.tcmsDocumentReference.update({ where: { id: anlage }, data });
    await expect(anlageAendern({ tcmsEventId: 'ereignisaaa1' })).resolves.toBeTruthy();
    await dbAbgewiesen(anlageAendern({ tcmsEventId: 'ereignisbbb2' }), ereignisEinmal);
    const freieAnlage = await verknuepft(await dokument(), {
      tcmsSubject: 'EVENT',
      tcmsExecutionId: null,
    });
    await owner.tcmsDocumentReference.update({
      where: { id: freieAnlage },
      data: { releasedAt: new Date(), releasedBy: staffA, releaseReason: 'DISCARDED' },
    });
    await dbAbgewiesen(
      owner.tcmsDocumentReference.update({
        where: { id: freieAnlage },
        data: { tcmsEventId: 'ereignisccc3' },
      }),
      ereignisEinmal,
    );
  });

  it('Tenant und Mandant gehören zusammen (00_tenant_client_pair_integrity)', async () => {
    const d = await dokument();
    await dbAbgewiesen(
      owner.tcmsDocumentReference.create({ data: { ...verweis(d), clientId: mandantB } }),
      {
        sqlState: '23503',
        meldung:
          'tenant_id und client_id gehören nicht zum selben Mandanten-Scope (tcms_document_reference).',
      },
    );
  });

  it('CHECK-Bedingungen, jede für sich (Trigger abgeschaltet)', async () => {
    const d = await dokument();
    const basis = verweis(d);
    const faelle: Array<[Record<string, unknown>, string]> = [
      [{ sha256: Buffer.alloc(31, 7) }, 'tcms_document_reference_sha256_check'],
      [{ tcmsEvidenceId: 'Nachweis-1' }, 'tcms_document_reference_evidence_id_check'],
      [{ tcmsExecutionId: 'durch führung' }, 'tcms_document_reference_execution_id_check'],
      [
        { tcmsSubject: 'EVENT', tcmsExecutionId: null, tcmsEventId: 'Ereignis-1' },
        'tcms_document_reference_event_id_check',
      ],
      // Offener Punkt (kk-tcms-qual): Eine Freigabe ganz ohne Grund (NULL)
      // erfüllt die Bedingung, weil `NULL = ANY (…)` NULL ergibt; geprüft
      // werden hier die Fälle, die sie heute abweist.
      [
        { releasedAt: new Date(), releaseReason: 'REMOVED' },
        'tcms_document_reference_release_check',
      ],
      [{ releasedBy: staffA, releaseReason: 'REMOVED' }, 'tcms_document_reference_release_check'],
      [
        { releasedAt: new Date(), releasedBy: staffA, releaseReason: 'VERLOREN' },
        'tcms_document_reference_release_check',
      ],
      [{ tcmsExecutionId: null }, 'tcms_document_reference_subject_check'],
      [{ tcmsEventId: 'ereignisaaa1' }, 'tcms_document_reference_subject_check'],
      [
        { tcmsSubject: 'EVENT', tcmsExecutionId: null, tcmsEvidenceId: 'nachweisaaa1' },
        'tcms_document_reference_subject_check',
      ],
      [
        { releasedAt: new Date(), releasedBy: staffA, releaseReason: 'DISCARDED' },
        'tcms_document_reference_subject_check',
      ],
      [
        {
          tcmsSubject: 'EVENT',
          tcmsExecutionId: null,
          releasedAt: new Date(),
          releasedBy: staffA,
          releaseReason: 'REMOVED',
        },
        'tcms_document_reference_subject_check',
      ],
      [{ tcmsSubject: 'ANDERES' }, 'tcms_document_reference_subject_check'],
    ];
    for (const [abweichung, constraint] of faelle) {
      await dbAbgewiesen(
        ohneTrigger((tx) => tx.tcmsDocumentReference.create({ data: { ...basis, ...abweichung } })),
        checkVerletzt(constraint),
        JSON.stringify(abweichung),
      );
    }
    // Gegenprobe: die Basiszeile selbst verletzt keine Bedingung.
    await expect(
      ohneTrigger((tx) => tx.tcmsDocumentReference.create({ data: basis })),
    ).resolves.toBeUndefined();
  });

  it('eine offene Verknüpfung je Nachweis-ID und Tenant (tcms_document_reference_open_evidence)', async () => {
    await verknuepft(await dokument(), { tcmsEvidenceId: 'nachweisddd4' });
    await dbAbgewiesen(verknuepft(await dokument(), { tcmsEvidenceId: 'nachweisddd4' }), {
      sqlState: '23505',
      meldung:
        'duplicate key value violates unique constraint "tcms_document_reference_open_evidence"',
    });
  });

  it('RLS: die App-Rolle sieht und ändert nur Verweise des eigenen Tenants', async () => {
    const fremd = await verknuepft(await dokument({ tenant: tenantB, mandant: mandantB }));
    const eigen = await verknuepft(await dokument());
    const sichtbar = (tenant: string, staff: string) =>
      alsApp(tenant, staff, (tx) =>
        tx.tcmsDocumentReference.findMany({
          where: { id: { in: [fremd, eigen] } },
          select: { id: true },
        }),
      );
    expect((await sichtbar(tenantA, staffA)).map((z) => z.id)).toEqual([eigen]);
    expect((await sichtbar(tenantB, staffB)).map((z) => z.id)).toEqual([fremd]);
    await expect(
      alsApp(tenantA, staffA, (tx) =>
        tx.tcmsDocumentReference.updateMany({
          where: { id: fremd },
          data: { tcmsEvidenceId: 'nachweiseee5' },
        }),
      ),
    ).resolves.toEqual({ count: 0 });
    expect(
      (await owner.tcmsDocumentReference.findUniqueOrThrow({ where: { id: fremd } }))
        .tcmsEvidenceId,
    ).toBeNull();
    // WITH CHECK allein: Trigger abgeschaltet (sonst lehnt der Paar-Guard vorher
    // ab) und Raw-SQL ohne RETURNING (sonst lehnt die SELECT-Policy die
    // zurückgegebene Zeile ab, mit derselben Meldung).
    const rls = {
      sqlState: '42501',
      meldung: 'new row violates row-level security policy for table "tcms_document_reference"',
    };
    const fremdesDokument = await dokument({ tenant: tenantB, mandant: mandantB });
    await dbAbgewiesen(
      alsAppNurPolicy(
        tenantA,
        'SELECT 1',
        (tx) => tx.$executeRaw`
          INSERT INTO public.tcms_document_reference
            (tenant_id, client_id, document_id, document_version_id, sha256, tcms_subject,
             tcms_execution_id, created_by)
          VALUES (${tenantB}::uuid, ${mandantB}::uuid, ${fremdesDokument.id}::uuid,
                  ${fremdesDokument.versionen[0]}::uuid, ${Buffer.alloc(32, 7)}, 'EXECUTION',
                  ${DURCHF}, ${staffB}::uuid)`,
      ),
      rls,
    );
    await dbAbgewiesen(
      alsAppNurPolicy(
        tenantA,
        'SELECT 1',
        (tx) => tx.$executeRaw`
          UPDATE public.tcms_document_reference SET tenant_id = ${tenantB}::uuid
           WHERE id = ${eigen}::uuid`,
      ),
      rls,
    );
  });

  it('die App-Rolle löscht keine Verweise (Rechte)', async () => {
    const id = await verknuepft(await dokument());
    await dbAbgewiesen(
      alsApp(tenantA, staffA, (tx) => tx.tcmsDocumentReference.delete({ where: { id } })),
      { sqlState: '42501', meldung: 'permission denied for table tcms_document_reference' },
    );
  });

  it('ein verknüpftes Dokument ist gegen Löschen gesperrt, bis die Verknüpfung frei ist', async () => {
    const d = await dokument();
    const id = await verknuepft(d);
    const gesperrt = {
      sqlState: '23001',
      meldung: 'document: als Nachweis im Tax-CMS verknüpft, Löschen gesperrt',
    };
    const loeschenAls = (db: 'owner' | 'app') => {
      const data = { deletedAt: new Date(), deletedByStaff: staffA };
      return db === 'owner'
        ? owner.document.update({ where: { id: d.id }, data })
        : alsApp(tenantA, staffA, (tx) => tx.document.update({ where: { id: d.id }, data }));
    };
    await dbAbgewiesen(loeschenAls('app'), gesperrt);
    await dbAbgewiesen(loeschenAls('owner'), gesperrt);
    await dbAbgewiesen(owner.document.delete({ where: { id: d.id } }), {
      sqlState: '23503',
      meldung: 'violates foreign key constraint "tcms_document_reference_document_id_fkey"',
    });
    await owner.tcmsDocumentReference.update({
      where: { id },
      data: { releasedAt: new Date(), releasedBy: staffA, releaseReason: 'NOT_ATTACHED' },
    });
    await expect(loeschenAls('app')).resolves.toMatchObject({ id: d.id });
  });
});

describeWithDatabase('tcms_systemakteur (MAIL-OUTBOX-001)', () => {
  it('Trigger: Tenant, Akteur-ID und Anlage unveränderlich, nur der Lease ändert sich', async () => {
    await owner.tcmsSystemakteur.create({ data: { tenantId: tenantA } });
    const unveraenderlich = {
      sqlState: '23001',
      meldung: 'TCMS_SYSTEMAKTEUR_UNVERAENDERLICH',
    };
    const aendern = (data: Record<string, unknown>) =>
      owner.tcmsSystemakteur.update({ where: { tenantId: tenantA }, data });
    await dbAbgewiesen(aendern({ akteurId: randomUUID() }), unveraenderlich);
    await dbAbgewiesen(aendern({ erstelltAm: new Date(0) }), unveraenderlich);
    await dbAbgewiesen(aendern({ tenantId: tenantB }), unveraenderlich);
    await expect(
      aendern({ laufHalter: randomUUID(), laufBis: new Date(Date.now() + 60_000) }),
    ).resolves.toBeTruthy();
  });

  it('CHECK: Lease nur vollständig (tcms_systemakteur_lauf_check)', async () => {
    for (const data of [{ laufHalter: randomUUID() }, { laufBis: new Date() }]) {
      await dbAbgewiesen(
        owner.tcmsSystemakteur.create({ data: { tenantId: tenantB, ...data } }),
        checkVerletzt('tcms_systemakteur_lauf_check'),
      );
    }
  });

  it('die App-Rolle hat keinen Zugriff (Rechte)', async () => {
    await dbAbgewiesen(
      alsApp(tenantA, staffA, (tx) => tx.tcmsSystemakteur.findMany()),
      {
        sqlState: '42501',
        meldung: 'permission denied for table tcms_systemakteur',
      },
    );
  });

  it('RLS: eine Rolle ohne BYPASSRLS sieht und schreibt nur den eigenen Tenant', async () => {
    const rechte = 'GRANT SELECT, INSERT, UPDATE ON public.tcms_systemakteur TO taxtronik_app';
    await alsAppNurPolicy(tenantB, rechte, async (tx) => {
      const zeilen = await tx.tcmsSystemakteur.findMany({ select: { tenantId: true } });
      // Tenant A hat einen Systemakteur (Test oben), er bleibt unsichtbar.
      expect(zeilen).toEqual([]);
      expect(
        await tx.tcmsSystemakteur.updateMany({ data: { laufHalter: null, laufBis: null } }),
      ).toEqual({ count: 0 });
    });
    await dbAbgewiesen(
      // Raw-SQL ohne RETURNING: nur WITH CHECK entscheidet.
      alsAppNurPolicy(
        tenantB,
        rechte,
        (tx) =>
          tx.$executeRaw`INSERT INTO public.tcms_systemakteur (tenant_id) VALUES (${tenantA}::uuid)`,
      ),
      {
        sqlState: '42501',
        meldung: 'new row violates row-level security policy for table "tcms_systemakteur"',
      },
    );
  });
});

describeWithDatabase('tcms_nachricht_zustellung (MAIL-OUTBOX-001)', () => {
  // Gültige Basis: eingeplant ist abgeschlossen (nur ZURUECKGESTELLT ist offen).
  const zustellung = (weiteres: Record<string, unknown> = {}) => ({
    tenantId: tenantA,
    nachrichtId: `n_${randomUUID().slice(0, 8)}`,
    zweck: 'FREIGABE_CODE',
    status: 'EINGEPLANT',
    abgeschlossenAm: new Date(),
    ...weiteres,
  });

  it('CHECK-Bedingungen, jede für sich', async () => {
    // CHECK-Bedingungen greifen in alphabetischer Reihenfolge: jeder Fall
    // verletzt genau eine.
    const faelle: Array<[Record<string, unknown>, string]> = [
      [{ status: 'VERSENDET', grund: 'ABGELAUFEN' }, 'tcms_nachricht_zustellung_status_check'],
      [{ zweck: 'WERBUNG' }, 'tcms_nachricht_zustellung_zweck_check'],
      [{ grund: 'ABGELAUFEN' }, 'tcms_nachricht_zustellung_grund_check'],
      [
        { status: 'UNZUSTELLBAR', grund: 'UNBEKANNT', abgeschlossenAm: new Date() },
        'tcms_nachricht_zustellung_grund_check',
      ],
      [
        { status: 'UNZUSTELLBAR', grund: 'KONTAKT_INAKTIV', abgeschlossenAm: null },
        'tcms_nachricht_zustellung_abschluss_check',
      ],
      [
        {
          status: 'ZURUECKGESTELLT',
          grund: 'KONTAKT_INAKTIV',
          abgeschlossenAm: null,
          gemeldetAm: new Date(),
        },
        'tcms_nachricht_zustellung_abschluss_check',
      ],
      [{ nachrichtId: 'nachricht/1' }, 'tcms_nachricht_zustellung_nachricht_id_check'],
      [{ nachrichtId: '' }, 'tcms_nachricht_zustellung_nachricht_id_check'],
    ];
    for (const [abweichung, constraint] of faelle) {
      await dbAbgewiesen(
        owner.tcmsNachrichtZustellung.create({ data: zustellung(abweichung) }),
        checkVerletzt(constraint),
        JSON.stringify(abweichung),
      );
    }
    await expect(
      owner.tcmsNachrichtZustellung.create({ data: zustellung() }),
    ).resolves.toBeTruthy();
  });

  it('höchstens eine Zustellung je Tenant und Mitteilung', async () => {
    const data = zustellung();
    await owner.tcmsNachrichtZustellung.create({ data });
    await dbAbgewiesen(owner.tcmsNachrichtZustellung.create({ data: { ...data } }), {
      sqlState: '23505',
      meldung:
        'duplicate key value violates unique constraint "tcms_nachricht_zustellung_tenant_nachricht_key"',
    });
  });

  it('die App-Rolle hat keinen Zugriff (Rechte)', async () => {
    await dbAbgewiesen(
      alsApp(tenantA, staffA, (tx) => tx.tcmsNachrichtZustellung.findMany()),
      {
        sqlState: '42501',
        meldung: 'permission denied for table tcms_nachricht_zustellung',
      },
    );
  });

  it('RLS: eine Rolle ohne BYPASSRLS sieht und schreibt nur den eigenen Tenant', async () => {
    const fremd = await owner.tcmsNachrichtZustellung.create({ data: zustellung() });
    const rechte =
      'GRANT SELECT, INSERT, UPDATE ON public.tcms_nachricht_zustellung TO taxtronik_app';
    await alsAppNurPolicy(tenantB, rechte, async (tx) => {
      expect(await tx.tcmsNachrichtZustellung.findMany({ where: { id: fremd.id } })).toEqual([]);
      expect(
        await tx.tcmsNachrichtZustellung.updateMany({
          where: { id: fremd.id },
          data: { geprueftAm: new Date() },
        }),
      ).toEqual({ count: 0 });
    });
    await alsAppNurPolicy(tenantA, rechte, async (tx) => {
      // Gegenprobe: im eigenen Tenant sichtbar.
      expect(await tx.tcmsNachrichtZustellung.count({ where: { id: fremd.id } })).toBe(1);
    });
    await dbAbgewiesen(
      // Raw-SQL ohne RETURNING: nur WITH CHECK entscheidet.
      alsAppNurPolicy(
        tenantB,
        rechte,
        (tx) => tx.$executeRaw`
          INSERT INTO public.tcms_nachricht_zustellung
            (tenant_id, nachricht_id, zweck, status, abgeschlossen_am)
          VALUES (${tenantA}::uuid, 'n_rls_pruefung', 'FREIGABE_CODE', 'EINGEPLANT', now())`,
      ),
      {
        sqlState: '42501',
        meldung: 'new row violates row-level security policy for table "tcms_nachricht_zustellung"',
      },
    );
  });
});

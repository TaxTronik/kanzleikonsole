// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001
// Fachkatalog: GWG-REPRESENTATIVE-AUTHORITY-001
// Fachkatalog: GWG-RISK-REVIEW-001
// Fachkatalog: GWG-ACTIVATION-GATE-001
// K-03: Die GwG-Services (Prelude withEditableGwgCheckTx, Ausweissätze,
// wirtschaftlich Berechtigte, Übergabe und Verifikation) laufen unverändert
// gegen echtes PostgreSQL mit der App-Rolle: RLS, GwG-Trigger, Lifecycle-
// Advisory-Lock und Status-CAS. Nur die Audit-Kette ist eine Attrappe; ihre
// Ereignisse werden aufgezeichnet und geprüft. Opt-in (GWG_SERVICES_DB_TEST=1)
// wie die übrigen Web-DB-Tests.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';

const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@/server/container', () => ({ evidenceService: { record: audit.record } }));

import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';
import { updateBeneficialOwnerTx } from '../beneficial-owners';
import { saveRiskAnswersTx, startGwgCheckCycleTx } from '../check-cycle';
import { submitCheckForReviewTx, verifyCheckTx } from '../check-decisions';
import { withEditableGwgCheckTx } from '../editable-check';
import { updateIdentityDocumentSetTx } from '../identity-document-confirmation';
import { addIdentityDocumentSetTx } from '../identity-document-sets';
import { NO_IDENTITY_PDF_PAGE_COUNTS } from '../identity-source';
import { addGwgPersonTx } from '../persons';
import {
  gwgBeneficialOwnerRevision,
  gwgIdentityDocumentSetRevision,
  gwgRiskRevision,
} from '../revisions';
import { gwgProfessionalReviewSnapshotHash } from '../review-snapshot';
import { DEFAULT_FACTORS } from '../risk-score';

// Echte Transaktionen auf einer geteilten Test-Instanz: großzügige Grenzen.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// B-02: lokal per GWG_SERVICES_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env.GWG_SERVICES_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'GWG_SERVICES_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    const url = new URL(process.env[name] ?? '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname.length < 2) {
      throw new Error(`GWG_SERVICES_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const NOT_EDITABLE = 'bereits abgeschlossen (verifiziert/abgelehnt/abgelaufen)';
const PARALLEL_CHANGE = 'Der Prüfstatus wurde parallel geändert';
const ID_CARD = {
  type: 'PERSONALAUSWEIS' as const,
  number: 'L01X00T47',
  issuedBy: 'Stadt Berlin',
  issueDate: '2024-01-15',
  expiryDate: '2034-01-14',
};

const IDENTITY_SET_REVISION_SELECT = {
  id: true,
  gwgCheckId: true,
  documentSetId: true,
  documentId: true,
  viewports: true,
  type: true,
  ownerName: true,
  number: true,
  issuedBy: true,
  issueDate: true,
  expiryDate: true,
  verifiedAt: true,
  naturalClientSubjectId: true,
  beneficialOwnerSubjectId: true,
  representativeSubjectId: true,
  identityAssignmentConfirmedAt: true,
  identityAssignmentConfirmedBy: true,
  supersededAt: true,
  supersededByDocumentSetId: true,
} as const;

(enabled ? describe : describe.skip)('GwG-Services gegen PostgreSQL (K-03)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  let tenantId = '';
  let staffId = '';
  let session: StaffSession;
  const actor = () => ({ tenantId, staffId, session });

  function inTx<T>(run: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
        return run(tx as unknown as TxClient);
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  async function newClient(kind: 'NATPERS' | 'JURPERS', name: string): Promise<string> {
    return (await owner.client.create({ data: { tenantId, name, kind } })).id;
  }

  /** Erstprüfung über den Produktionsservice (INITIAL, DRAFT). */
  async function openCheck(clientId: string): Promise<string> {
    const { checkId } = await inTx((tx) =>
      startGwgCheckCycleTx(
        tx,
        { clientId, expectedLatestCheckId: '', changeScope: 'ROUTINE' },
        actor(),
      ),
    );
    return checkId;
  }

  /** Sauber gescannter GwG-Aktenbeleg (wie gwg-test-fixture). */
  async function evidenceDocument(clientId: string, title: string): Promise<string> {
    return owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
      const document = await tx.document.create({
        data: {
          tenantId,
          clientId,
          title,
          classification: 'GWG_EVIDENCE',
          mimeType: 'image/jpeg',
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: document.id,
          versionNo: 1,
          storageBucket: 'gwg-test',
          storageKey: `gwg-test/${document.id}/v1`,
          sha256: Buffer.alloc(32, 0x7a),
          sizeBytes: 1n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: staffId,
        },
      });
      return document.id;
    });
  }

  function identityRows(checkId: string) {
    return owner.gwgIdDocument.findMany({
      where: { gwgCheckId: checkId },
      select: IDENTITY_SET_REVISION_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  function addPersonalIdSet(
    input: { checkId: string; clientId: string; subjectKey: string; documentIds: string[] },
    replacementMode: 'none' | 'subject' = 'none',
  ) {
    return inTx((tx) =>
      addIdentityDocumentSetTx(
        tx,
        { ...input, ...ID_CARD, replacementMode, replaceDocumentSetId: '', viewports: [] },
        actor(),
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    );
  }

  async function confirmPersonalIdSet(input: {
    checkId: string;
    clientId: string;
    subjectKey: string;
    documentSetId: string;
  }) {
    const active = (await identityRows(input.checkId)).filter(
      (row) => row.documentSetId === input.documentSetId && row.supersededAt === null,
    );
    return inTx((tx) =>
      updateIdentityDocumentSetTx(
        tx,
        {
          ...input,
          ...ID_CARD,
          intent: 'confirm',
          expectedRevision: gwgIdentityDocumentSetRevision(active),
        },
        actor(),
        NO_IDENTITY_PDF_PAGE_COUNTS,
      ),
    );
  }

  /** Derselbe Snapshot wie in verifyCheckTx (Hash des angezeigten Prüfstands). */
  async function reviewSnapshotHash(checkId: string): Promise<string> {
    const check = await owner.gwgCheck.findUniqueOrThrow({
      where: { id: checkId },
      include: {
        client: {
          select: {
            id: true,
            kind: true,
            name: true,
            street: true,
            postalCode: true,
            city: true,
            countryIso: true,
          },
        },
        beneficialOwners: true,
        representatives: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
        idDocuments: {
          include: {
            document: {
              select: {
                id: true,
                clientId: true,
                classification: true,
                deletedAt: true,
                gwgDestructionRequestedAt: true,
                gwgDestroyedAt: true,
                versions: {
                  orderBy: { versionNo: 'desc' },
                  take: 1,
                  select: { scanStatus: true, scanCompletedAt: true },
                },
              },
            },
          },
        },
      },
    });
    return gwgProfessionalReviewSnapshotHash(check);
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({
        data: { slug: `gwg-services-db-${suffix}`, name: 'Synthetic GwG service tenant' },
      })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `${suffix}@example.test`,
          fullName: 'Synthetic professional',
          passwordHash: 'x',
          isProfessional: true,
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    session = {
      user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
    } as unknown as StaffSession;
  }, 60_000);

  beforeEach(() => {
    audit.record.mockReset();
    audit.record.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    try {
      if (tenantId) await owner.tenant.delete({ where: { id: tenantId } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  describe('Prelude withEditableGwgCheckTx', () => {
    it('weist Änderungen an einer abgeschlossenen Prüfung ohne Schreibzugriff ab (§ 8 GwG)', async () => {
      const clientId = await newClient('JURPERS', 'Verifiziert GmbH');
      const verified = await createVerifiedLegalEntityGwgFixture(owner as never, {
        tenantId,
        clientId,
        verifiedBy: staffId,
      });
      const ownersBefore = await owner.gwgBeneficialOwner.count({
        where: { gwgCheckId: verified.id },
      });

      await expect(
        inTx((tx) =>
          addGwgPersonTx(
            tx,
            {
              checkId: verified.id,
              clientId,
              fullName: 'Nachzügler',
              isBeneficialOwner: true,
              isRepresentative: false,
              birthDate: '1980-01-02',
              birthPlace: 'Berlin',
              residence: 'Musterstraße 1, 10115 Berlin',
              nationality: 'deutsch',
              isPep: false,
            },
            actor(),
          ),
        ),
      ).rejects.toThrow(NOT_EDITABLE);
      await expect(
        inTx((tx) =>
          saveRiskAnswersTx(
            tx,
            {
              checkId: verified.id,
              clientId,
              answers: Object.fromEntries(DEFAULT_FACTORS.map((factor) => [factor.key, 0])),
              expectedRevision: gwgRiskRevision(verified),
            },
            actor(),
          ),
        ),
      ).rejects.toThrow(NOT_EDITABLE);

      const after = await owner.gwgCheck.findUniqueOrThrow({ where: { id: verified.id } });
      expect(after.status).toBe('VERIFIED');
      expect(after.riskScore).toBe(verified.riskScore);
      expect(await owner.gwgBeneficialOwner.count({ where: { gwgCheckId: verified.id } })).toBe(
        ownersBefore,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('bindet die Prüfung an den autorisierten Mandanten', async () => {
      const clientId = await newClient('JURPERS', 'Bindung GmbH');
      const otherClientId = await newClient('JURPERS', 'Fremd GmbH');
      const checkId = await openCheck(clientId);
      const operation = vi.fn();

      await expect(
        inTx((tx) =>
          withEditableGwgCheckTx(
            tx,
            actor(),
            { clientId: otherClientId, checkId, select: { status: true } },
            operation,
          ),
        ),
      ).rejects.toThrow('GwG-Check nicht gefunden.');
      expect(operation).not.toHaveBeenCalled();
    });

    it('serialisiert konkurrierende Bearbeitungen desselben Mandanten am Lifecycle-Lock', async () => {
      const clientId = await newClient('JURPERS', 'Lock GmbH');
      const checkId = await openCheck(clientId);
      await owner.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'IN_REVIEW', reviewSubmittedAt: new Date(), reviewSubmittedBy: staffId },
      });
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
      let firstClaimed!: () => void;
      const firstHoldsLock = new Promise<void>((resolve) => (firstClaimed = resolve));

      const first = inTx((tx) =>
        withEditableGwgCheckTx(
          tx,
          actor(),
          { clientId, checkId, select: { status: true } },
          async (check, mutation) => {
            order.push(`first:${check.status}`);
            await mutation.claim();
            firstClaimed();
            await firstMayCommit;
          },
        ),
      );
      await firstHoldsLock;
      const second = inTx((tx) =>
        withEditableGwgCheckTx(
          tx,
          actor(),
          { clientId, checkId, select: { status: true } },
          async (check) => {
            order.push(`second:${check.status}`);
          },
        ),
      );

      // Die zweite Transaktion wartet am Advisory-Lock, bevor sie den Snapshot liest.
      await expect
        .poll(
          async () =>
            (
              await owner.$queryRaw<Array<{ waiting: number }>>`
                SELECT count(*)::int AS waiting
                  FROM pg_locks
                 WHERE locktype = 'advisory'
                   AND NOT granted
                   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              `
            )[0]!.waiting,
          { timeout: 5_000 },
        )
        .toBe(1);
      expect(order).toEqual(['first:IN_REVIEW']);

      releaseFirst();
      await Promise.all([first, second]);
      // Erst nach dem Commit liest die zweite Operation den zurückgesetzten Status.
      expect(order).toEqual(['first:IN_REVIEW', 'second:DRAFT']);
      const after = await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } });
      expect(after).toMatchObject({ status: 'DRAFT', reviewSubmittedAt: null });
    });

    it('verwirft Claim und No-op-CAS nach einem parallelen Statuswechsel', async () => {
      const clientId = await newClient('JURPERS', 'CAS GmbH');
      const checkId = await openCheck(clientId);
      const operation = (step: 'claim' | 'confirmUnchanged') =>
        inTx((tx) =>
          withEditableGwgCheckTx(
            tx,
            actor(),
            { clientId, checkId, select: { status: true } },
            async (check, mutation) => {
              expect(check.status).toBe('DRAFT');
              // Ein Schreiber außerhalb dieses Locks ändert den Status zwischen
              // Laden und Claim (der Lock schützt nur kooperierende Pfade).
              await owner.gwgCheck.update({
                where: { id: checkId },
                data: {
                  status: 'IN_REVIEW',
                  reviewSubmittedAt: new Date(),
                  reviewSubmittedBy: staffId,
                },
              });
              if (step === 'claim') await mutation.claim({ invalidateRisk: true });
              else await mutation.confirmUnchanged();
            },
          ),
        );

      await expect(operation('claim')).rejects.toThrow(PARALLEL_CHANGE);
      // Der Claim hat die parallele Übergabe nicht zurückgesetzt.
      expect(await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } })).toMatchObject({
        status: 'IN_REVIEW',
        reviewSubmittedBy: staffId,
      });

      await owner.gwgCheck.update({
        where: { id: checkId },
        data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
      });
      await expect(operation('confirmUnchanged')).rejects.toThrow(PARALLEL_CHANGE);
    });
  });

  it('GWG-IDENTIFICATION-EVIDENCE-001: legt einen unbestätigten Ausweissatz an und ersetzt ihn atomar', async () => {
    const clientId = await newClient('NATPERS', 'Max Mustermann');
    const checkId = await openCheck(clientId);
    const firstDocumentId = await evidenceDocument(clientId, 'Personalausweis alt');
    const secondDocumentId = await evidenceDocument(clientId, 'Personalausweis neu');
    const subjectKey = `client:${clientId}`;

    expect(
      await addPersonalIdSet({ checkId, clientId, subjectKey, documentIds: [firstDocumentId] }),
    ).toBeUndefined();
    const [first] = await identityRows(checkId);
    expect(first).toMatchObject({
      documentId: firstDocumentId,
      type: 'PERSONALAUSWEIS',
      ownerName: 'Max Mustermann',
      number: ID_CARD.number,
      naturalClientSubjectId: clientId,
      verifiedAt: null,
      identityAssignmentConfirmedAt: null,
      supersededAt: null,
    });
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.id_document.add',
        resourceType: 'gwg_id_document',
        resourceId: first!.id,
        before: undefined,
        after: expect.objectContaining({ replacementMode: 'none', documentIds: [firstDocumentId] }),
      }),
    );
    const folder = await owner.document.findUniqueOrThrow({
      where: { id: firstDocumentId },
      select: { folder: { select: { name: true, parent: { select: { name: true } } } } },
    });
    expect(folder.folder).toMatchObject({ name: 'Max Mustermann', parent: { name: 'GwG' } });

    expect(
      await addPersonalIdSet(
        { checkId, clientId, subjectKey, documentIds: [secondDocumentId] },
        'subject',
      ),
    ).toEqual({ reviewReset: false });
    const rows = await identityRows(checkId);
    const replacement = rows.find((row) => row.documentId === secondDocumentId)!;
    expect(rows.find((row) => row.id === first!.id)).toMatchObject({
      supersededByDocumentSetId: replacement.documentSetId,
    });
    expect(rows.find((row) => row.id === first!.id)!.supersededAt).not.toBeNull();
    expect(replacement.supersededAt).toBeNull();
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.id_document.replace',
        before: { replacedDocuments: [expect.objectContaining({ id: first!.id })] },
        after: expect.objectContaining({ replacementMode: 'subject' }),
      }),
    );
    // Der Originalbeleg bleibt in der Mandantenakte.
    expect(await owner.document.count({ where: { id: firstDocumentId, deletedAt: null } })).toBe(1);
  });

  it('GWG-BENEFICIAL-OWNERS-001: korrigiert einen Berechtigten samt Doppelrolle und entbestätigt dessen Ausweis', async () => {
    const clientId = await newClient('JURPERS', 'Doppelrolle GmbH');
    const checkId = await openCheck(clientId);
    await inTx((tx) =>
      addGwgPersonTx(
        tx,
        {
          checkId,
          clientId,
          fullName: 'Erika Muster',
          isBeneficialOwner: true,
          isRepresentative: true,
          birthDate: '1980-01-02',
          birthPlace: 'Berlin',
          residence: 'Musterstraße 1, 10115 Berlin',
          nationality: 'deutsch',
          ownershipPct: 60,
          isPep: false,
        },
        actor(),
      ),
    );
    const storedOwner = await owner.gwgBeneficialOwner.findFirstOrThrow({
      where: { gwgCheckId: checkId },
    });
    const representative = await owner.gwgRepresentative.findFirstOrThrow({
      where: { gwgCheckId: checkId },
    });
    expect(representative.linkedBeneficialOwnerId).toBe(storedOwner.id);

    const documentId = await evidenceDocument(clientId, 'Ausweis Erika Muster');
    const subjectKey = `representative:${representative.id}`;
    await addPersonalIdSet({ checkId, clientId, subjectKey, documentIds: [documentId] });
    const [identity] = await identityRows(checkId);
    expect(
      await confirmPersonalIdSet({
        checkId,
        clientId,
        subjectKey,
        documentSetId: identity!.documentSetId,
      }),
    ).toMatchObject({ verified: true, reviewReset: false });
    expect((await identityRows(checkId))[0]!.verifiedAt).not.toBeNull();

    const stale = gwgBeneficialOwnerRevision(storedOwner);
    const correction = {
      ownerId: storedOwner.id,
      checkId,
      clientId,
      fullName: 'Erika Muster-Neu',
      birthDate: '1980-01-02',
      birthPlace: 'Berlin',
      residence: 'Musterstraße 1, 10115 Berlin',
      nationality: 'deutsch',
      ownershipPct: 60,
      isPep: false,
      expectedRevision: stale,
    };
    audit.record.mockClear();
    const result = await inTx((tx) => updateBeneficialOwnerTx(tx, correction, actor()));

    const identityAfter = await identityRows(checkId);
    expect(result).toEqual({
      reviewReset: false,
      invalidatedIdentitySets: [
        {
          documentSetId: identity!.documentSetId,
          // Dieselbe Revision wie die CAS-Prüfung beim nächsten Speichern
          // (inklusive viewports); vorher fehlten sie und das Speichern scheiterte.
          revision: gwgIdentityDocumentSetRevision(identityAfter),
        },
      ],
      revision: expect.any(String),
      saved: expect.objectContaining({ fullName: 'Erika Muster-Neu', ownershipPct: '60' }),
    });
    expect(identityAfter[0]).toMatchObject({
      verifiedAt: null,
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    });
    const ownerAfter = await owner.gwgBeneficialOwner.findUniqueOrThrow({
      where: { id: storedOwner.id },
    });
    expect(ownerAfter.fullName).toBe('Erika Muster-Neu');
    expect(result.revision).toBe(gwgBeneficialOwnerRevision(ownerAfter));
    expect(
      (await owner.gwgRepresentative.findUniqueOrThrow({ where: { id: representative.id } }))
        .fullName,
    ).toBe('Erika Muster-Neu');
    expect(await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } })).toMatchObject({
      status: 'DRAFT',
      representativeNames: ['Erika Muster-Neu'],
      riskScore: null,
      riskLevel: null,
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.owner.update',
        resourceType: 'gwg_beneficial_owner',
        resourceId: storedOwner.id,
        before: expect.objectContaining({ fullName: 'Erika Muster', ownershipPct: '60' }),
        after: expect.objectContaining({
          fullName: 'Erika Muster-Neu',
          invalidatedIdentityDocuments: 1,
        }),
      }),
    );

    // Eine veraltete Revision überschreibt nichts.
    await expect(
      inTx((tx) =>
        updateBeneficialOwnerTx(tx, { ...correction, fullName: 'Dritte Fassung' }, actor()),
      ),
    ).rejects.toThrow('Die Personendaten wurden zwischenzeitlich geändert.');
    expect(
      (await owner.gwgBeneficialOwner.findUniqueOrThrow({ where: { id: storedOwner.id } }))
        .fullName,
    ).toBe('Erika Muster-Neu');
  });

  it('GWG-RISK-REVIEW-001 / GWG-ACTIVATION-GATE-001: übergibt und verifiziert einen vollständigen Snapshot', async () => {
    const clientId = await newClient('NATPERS', 'Mia Musterfrau');
    const checkId = await openCheck(clientId);
    const documentId = await evidenceDocument(clientId, 'Personalausweis Mia');
    const subjectKey = `client:${clientId}`;
    await addPersonalIdSet({ checkId, clientId, subjectKey, documentIds: [documentId] });
    const [identity] = await identityRows(checkId);
    await confirmPersonalIdSet({
      checkId,
      clientId,
      subjectKey,
      documentSetId: identity!.documentSetId,
    });
    const riskBefore = await owner.gwgCheck.findUniqueOrThrow({
      where: { id: checkId },
      select: { riskAnswers: true, riskScore: true, riskLevel: true },
    });
    expect(
      await inTx((tx) =>
        saveRiskAnswersTx(
          tx,
          {
            checkId,
            clientId,
            answers: Object.fromEntries(DEFAULT_FACTORS.map((factor) => [factor.key, 0])),
            expectedRevision: gwgRiskRevision(riskBefore),
          },
          actor(),
        ),
      ),
    ).toMatchObject({ reviewReset: false });

    // Ablehnung: ohne zugeordneten Berufsträger keine Übergabe.
    await expect(
      inTx((tx) => submitCheckForReviewTx(tx, { checkId, clientId }, actor())),
    ).rejects.toThrow('Bitte zuerst einen verantwortlichen Berufsträger');
    expect((await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } })).status).toBe(
      'DRAFT',
    );

    await owner.clientResponsibility.create({
      data: { tenantId, clientId, staffId, role: 'BERUFSTRAEGER' },
    });
    audit.record.mockClear();
    await inTx((tx) => submitCheckForReviewTx(tx, { checkId, clientId }, actor()));
    expect(await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } })).toMatchObject({
      status: 'IN_REVIEW',
      reviewSubmittedBy: staffId,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.check.submit_for_review',
        after: expect.objectContaining({ reviewerIds: [staffId] }),
      }),
    );
    expect(
      await owner.notification.count({
        where: { tenantId, kind: 'GWG_ONBOARDING_SUBMITTED', resourceId: checkId, readAt: null },
      }),
    ).toBe(1);

    // Ablehnung: ein nicht mehr angezeigter Snapshot wird nicht verifiziert.
    await expect(
      inTx((tx) =>
        verifyCheckTx(tx, { checkId, clientId, reviewSnapshotHash: '0'.repeat(64) }, actor()),
      ),
    ).rejects.toThrow('Der angezeigte GwG-Snapshot ist nicht mehr aktuell.');
    expect((await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } })).status).toBe(
      'IN_REVIEW',
    );

    const hash = await reviewSnapshotHash(checkId);
    audit.record.mockClear();
    const startedAt = Date.now();
    const verified = await inTx((tx) =>
      verifyCheckTx(tx, { checkId, clientId, reviewSnapshotHash: hash }, actor()),
    );

    expect(verified.sendActivationWelcome).toBe(true);
    const check = await owner.gwgCheck.findUniqueOrThrow({ where: { id: checkId } });
    expect(check).toMatchObject({ status: 'VERIFIED', verifiedBy: staffId, riskLevel: 'LOW' });
    expect(check.validUntil!.toISOString()).toBe(verified.validUntil);
    const threeYears = 3 * 365 * 24 * 60 * 60 * 1000;
    expect(check.validUntil!.getTime()).toBeGreaterThanOrEqual(startedAt + threeYears);
    expect(check.validUntil!.getTime()).toBeLessThanOrEqual(Date.now() + threeYears);
    expect((await owner.client.findUniqueOrThrow({ where: { id: clientId } })).allowActive).toBe(
      true,
    );
    expect(
      await owner.mailOutbox.count({
        where: { tenantId, clientId, purpose: 'gwg-activated', resourceId: checkId },
      }),
    ).toBe(1);
    expect(
      await owner.notification.count({
        where: { tenantId, kind: 'GWG_ONBOARDING_SUBMITTED', resourceId: checkId, readAt: null },
      }),
    ).toBe(0);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'gwg.check.verify',
        resourceId: checkId,
        after: expect.objectContaining({
          riskLevel: 'LOW',
          reviewSnapshotHash: hash,
          reviewSnapshotVersion: 2,
          professionalAttestation: true,
          reviewSubmittedBy: staffId,
        }),
      }),
    );
  });
});

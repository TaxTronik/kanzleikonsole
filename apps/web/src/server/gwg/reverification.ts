import { randomUUID } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { Prisma } from '@prisma/client';

// Derselbe transaktionsgebundene Lifecycle-Lock wird aus mehreren
// Defense-in-Depth-Schichten angefordert. Ein WeakMap-Eintrag lebt exakt so
// lange wie der Tx-Client und verhindert den ansonsten redundanten zweiten
// SQL-Roundtrip, ohne den Lock an einem Aufrufpfad wegzulassen. Auch parallele
// Aufrufe auf derselben Tx teilen sich dieselbe Acquisition-Promise.
const lifecycleLockAcquisitions = new WeakMap<object, Map<string, Promise<void>>>();

export interface ReverificationResult {
  invalidatedChecks: number;
  invalidatedIdentityDocuments: number;
  reviewCheckId: string | null;
  clientDeactivated: boolean;
}

export type GwgChangeScopeInput =
  | 'INITIAL'
  | 'CLIENT_MASTER_DATA'
  | 'ROUTINE'
  | 'BENEFICIAL_OWNERS'
  | 'REPRESENTATIVES'
  | 'BOTH';

export const GWG_SNAPSHOT_COPY_INCLUDE = {
  beneficialOwners: true,
  representatives: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
  },
  idDocuments: {
    include: {
      document: {
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          classification: true,
          deletedAt: true,
          gwgDestructionRequestedAt: true,
          gwgDestroyedAt: true,
        },
      },
    },
  },
} as const satisfies Prisma.GwgCheckInclude;

type GwgSnapshotCopyPayload = Prisma.GwgCheckGetPayload<{
  include: typeof GWG_SNAPSHOT_COPY_INCLUDE;
}>;

type GwgSnapshotOwner = GwgSnapshotCopyPayload['beneficialOwners'][number];
type GwgSnapshotRepresentative = GwgSnapshotCopyPayload['representatives'][number];
type GwgSnapshotDocument = GwgSnapshotCopyPayload['idDocuments'][number];
type GwgSnapshotEvidence = NonNullable<GwgSnapshotDocument['document']>;

export type GwgSnapshotCopySource = Pick<
  GwgSnapshotCopyPayload,
  | 'destroyedAt'
  | 'notes'
  | 'legalForm'
  | 'registerNumber'
  | 'registerAuthority'
  | 'noRegisterEntry'
  | 'representativeNames'
  | 'ownershipStructureNotes'
> & {
  beneficialOwners: Array<
    Pick<
      GwgSnapshotOwner,
      | 'id'
      | 'fullName'
      | 'birthDate'
      | 'birthPlace'
      | 'residence'
      | 'nationality'
      | 'ownershipPct'
      | 'isPep'
      | 'notes'
    > & { personAnchorId?: string | null }
  >;
  representatives: Array<
    Pick<GwgSnapshotRepresentative, 'id' | 'fullName' | 'position' | 'linkedBeneficialOwnerId'> & {
      personAnchorId?: string | null;
    }
  >;
  idDocuments: Array<
    Pick<
      GwgSnapshotDocument,
      | 'documentSetId'
      | 'documentId'
      | 'type'
      | 'ownerName'
      | 'number'
      | 'issuedBy'
      | 'issueDate'
      | 'expiryDate'
      | 'notes'
    > & {
      viewports?: Prisma.JsonValue | null;
      document: Pick<
        GwgSnapshotEvidence,
        | 'id'
        | 'tenantId'
        | 'clientId'
        | 'classification'
        | 'deletedAt'
        | 'gwgDestructionRequestedAt'
        | 'gwgDestroyedAt'
      > | null;
    }
  >;
};

export interface CopyGwgSnapshotResult {
  copiedOwnerCount: number;
  copiedDocumentCount: number;
  copiedLinkedDocumentCount: number;
}

/**
 * Kopiert ausschliesslich die Identifizierungsgrundlage eines unveraenderten
 * Terminal-Snapshots in einen frischen Check. Risiko, Pruefstatus,
 * Bestaetigungen und Subject-Zuordnungen werden absichtlich nie uebernommen.
 */
export async function copyGwgSnapshotTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    targetCheckId: string;
    source: GwgSnapshotCopySource | null;
  },
): Promise<CopyGwgSnapshotResult> {
  const source = input.source;
  if (!source || source.destroyedAt !== null) {
    return { copiedOwnerCount: 0, copiedDocumentCount: 0, copiedLinkedDocumentCount: 0 };
  }

  const copiedOwnerIds = new Map(source.beneficialOwners.map((owner) => [owner.id, randomUUID()]));
  const copiedDocumentSetIds = new Map<string, string>();
  const documentsToCopy = source.idDocuments
    .filter(
      (document) =>
        (document as typeof document & { supersededAt?: Date | null }).supersededAt == null,
    )
    .map((document) => {
      const evidence = document.document;
      const reusableDocumentId =
        evidence &&
        evidence.id === document.documentId &&
        evidence.tenantId === input.tenantId &&
        evidence.clientId === input.clientId &&
        evidence.classification === 'GWG_EVIDENCE' &&
        evidence.deletedAt === null &&
        evidence.gwgDestructionRequestedAt === null &&
        evidence.gwgDestroyedAt === null
          ? evidence.id
          : null;
      let copiedDocumentSetId = copiedDocumentSetIds.get(document.documentSetId);
      if (!copiedDocumentSetId) {
        copiedDocumentSetId = randomUUID();
        copiedDocumentSetIds.set(document.documentSetId, copiedDocumentSetId);
      }
      return {
        gwgCheckId: input.targetCheckId,
        type: document.type,
        ownerName: document.ownerName,
        documentId: reusableDocumentId,
        number: document.number,
        issuedBy: document.issuedBy,
        issueDate: document.issueDate,
        expiryDate: document.expiryDate,
        // Sets sind check-lokal; Vorder-/Rueckseite behalten nur innerhalb des
        // neuen Checks dieselbe, frisch erzeugte Gruppen-ID.
        documentSetId: copiedDocumentSetId,
        notes: document.notes,
        ...(reusableDocumentId && document.viewports ? { viewports: document.viewports } : {}),
      };
    });

  await tx.gwgCheck.update({
    where: { id: input.targetCheckId },
    data: {
      notes: source.notes,
      legalForm: source.legalForm,
      registerNumber: source.registerNumber,
      registerAuthority: source.registerAuthority,
      noRegisterEntry: source.noRegisterEntry,
      representativeNames: source.representativeNames,
      ownershipStructureNotes: source.ownershipStructureNotes,
    },
  });
  if (source.beneficialOwners.length > 0) {
    await tx.gwgBeneficialOwner.createMany({
      data: source.beneficialOwners.map((owner) => ({
        id: copiedOwnerIds.get(owner.id)!,
        gwgCheckId: input.targetCheckId,
        fullName: owner.fullName,
        birthDate: owner.birthDate,
        birthPlace: owner.birthPlace,
        residence: owner.residence,
        nationality: owner.nationality,
        ownershipPct: owner.ownershipPct,
        isPep: owner.isPep,
        notes: owner.notes,
        personAnchorId: owner.personAnchorId ?? null,
      })),
    });
  }
  if (source.representatives.length > 0) {
    await tx.gwgRepresentative.createMany({
      data: source.representatives.map((representative) => ({
        gwgCheckId: input.targetCheckId,
        fullName: representative.fullName,
        personAnchorId: representative.personAnchorId ?? null,
        position: representative.position,
        linkedBeneficialOwnerId: representative.linkedBeneficialOwnerId
          ? (copiedOwnerIds.get(representative.linkedBeneficialOwnerId) ?? null)
          : null,
      })),
    });
  }
  if (documentsToCopy.length > 0) {
    await tx.gwgIdDocument.createMany({ data: documentsToCopy });
  }

  return {
    copiedOwnerCount: source.beneficialOwners.length,
    copiedDocumentCount: documentsToCopy.length,
    copiedLinkedDocumentCount: documentsToCopy.filter((document) => document.documentId !== null)
      .length,
  };
}

/**
 * Erzeugt unter dem Lifecycle-Lock einen fachlich monotonen Zeitstempel.
 * PostgreSQLs CURRENT_TIMESTAMP ist an den Transaktionsstart gebunden: Eine
 * früh gestartete, später am Advisory-Lock fortgesetzte Transaktion könnte
 * sonst einen neueren Snapshot mit einem älteren created_at anlegen. Der
 * statement_timestamp wird erst nach Lock-Erwerb gelesen und bei Millisekunden-
 * Gleichstand gegenüber dem bisherigen Maximum explizit fortgeschrieben.
 */
async function nextGwgCheckCreatedAtTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<Date> {
  const [clock] = await tx.$queryRaw<
    Array<{ statementTimestamp: Date; latestCreatedAt: Date | null }>
  >`
    SELECT
      statement_timestamp() AS "statementTimestamp",
      MAX(created_at) AS "latestCreatedAt"
    FROM gwg_check
    WHERE tenant_id = ${input.tenantId}::uuid
      AND client_id = ${input.clientId}::uuid
  `;
  if (!clock?.statementTimestamp) {
    throw new Error('Datenbankzeit für GwG-Prüfzyklus konnte nicht ermittelt werden.');
  }
  const previousNext = clock.latestCreatedAt
    ? clock.latestCreatedAt.getTime() + 1
    : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(clock.statementTimestamp.getTime(), previousNext));
}

async function createFreshGwgDraftTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    predecessorCheckId?: string | null;
    changeScope?: GwgChangeScopeInput;
  },
): Promise<{ id: string }> {
  const createdAt = await nextGwgCheckCreatedAtTx(tx, input);
  return tx.gwgCheck.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: 'DRAFT',
      createdAt,
      predecessorCheckId: input.predecessorCheckId ?? null,
      changeScope: input.changeScope ?? 'INITIAL',
    },
    select: { id: true },
  });
}

/**
 * Serialisiert alle statusentscheidenden GwG-Operationen eines Mandanten.
 *
 * Der Lock ist transaktionsgebunden und umfasst bewusst Tenant und Mandant:
 * Zwischen "ist dies der neueste Check?" und einem Statuswechsel darf kein
 * paralleler Pfad einen neuen Snapshot anlegen oder Stammdaten invalidieren.
 * Alle Aufrufer muessen den Lock vor der ersten Client-/GwG-Mutation nehmen.
 */
export async function lockGwgCheckLifecycleTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<void> {
  const lockKey = `gwg-check-lifecycle:${input.tenantId}:${input.clientId}`;
  let acquisitions = lifecycleLockAcquisitions.get(tx as object);
  if (!acquisitions) {
    acquisitions = new Map();
    lifecycleLockAcquisitions.set(tx as object, acquisitions);
  }
  const existing = acquisitions.get(lockKey);
  if (existing) return existing;

  const acquisition = (async () => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  })();
  acquisitions.set(lockKey, acquisition);
  try {
    await acquisition;
  } catch (error) {
    // Ein fehlgeschlagener Versuch darf einen späteren Retry auf derselben Tx
    // nicht fälschlich als gehaltenen Lock behandeln.
    if (acquisitions.get(lockKey) === acquisition) acquisitions.delete(lockKey);
    throw error;
  }
}

/**
 * Beansprucht einen oeffentlichen Onboarding-Submit atomar. Der Claim liegt in
 * derselben DB-Transaktion wie Stammdaten, Check, Einwilligung und Nachweise:
 * scheitert spaeter ein Schritt, wird auch der Statuswechsel zurueckgerollt.
 *
 * Das statusgebundene updateMany ist zugleich die Zeilensperre fuer
 * Parallelaufrufe. Nach dem Warten wertet PostgreSQL die WHERE-Bedingung erneut
 * aus; genau ein Aufruf kann PENDING/STARTED -> SUBMITTED vollziehen.
 */
export async function claimGwgOnboardingSubmitTx(
  tx: TxClient,
  input: {
    inviteId: string;
    tokenHash: string;
    submittedAt: Date;
    submittedIp: string | null;
    submittedUa: string | null;
  },
): Promise<boolean> {
  const claimed = await tx.gwgOnboardingInvite.updateMany({
    where: {
      id: input.inviteId,
      tokenHash: input.tokenHash,
      status: { in: ['PENDING', 'STARTED'] },
      expiresAt: { gt: input.submittedAt },
    },
    data: {
      status: 'SUBMITTED',
      submittedAt: input.submittedAt,
      submittedIp: input.submittedIp,
      submittedUa: input.submittedUa,
    },
  });
  return claimed.count === 1;
}

/**
 * Sperrt und revalidiert eine Einladung unmittelbar vor dem DB-Commit eines
 * bereits gescannten Uploads. So kann ein parallel abgeschlossener Submit
 * nicht nachtraeglich weitere Dokumente an einen SUBMITTED-Invite haengen.
 */
export async function lockGwgOnboardingUploadTx(
  tx: TxClient,
  input: {
    inviteId: string;
    tenantId: string;
    clientId: string;
    tokenHash: string;
    now: Date;
  },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM gwg_onboarding_invite
    WHERE id = ${input.inviteId}::uuid
      AND tenant_id = ${input.tenantId}::uuid
      AND client_id = ${input.clientId}::uuid
      AND token_hash = ${input.tokenHash}
      AND status IN ('PENDING'::gwg_invite_status, 'STARTED'::gwg_invite_status)
      AND expires_at > ${input.now}
    FOR UPDATE
  `;
  return rows.length === 1;
}

/**
 * Entwertet abgeschlossene Prüf-Snapshots, ohne deren Substanzdaten zu
 * überschreiben. Sobald die bisherige Identitätsgrundlage nicht mehr gilt,
 * muss der Mandant fail-closed inaktiv sein. Für Staff-Stammdatenänderungen
 * wird ein bereits offener Review wiederverwendet oder ein neuer angelegt.
 */
export async function requireGwgReverificationTx(
  tx: TxClient,
  input: { tenantId: string; clientId: string },
): Promise<ReverificationResult> {
  // Defense in Depth fuer neue Aufrufer. Bereits vom aeusseren Pfad gehaltene
  // Advisory-xact-Locks koennen innerhalb derselben Transaktion erneut genommen
  // werden und bleiben bis zum Commit/Rollback aktiv.
  await lockGwgCheckLifecycleTx(tx, input);

  // Der Vorgänger wird vor der Statusentwertung gelesen: Der aktuell gültige
  // VERIFIED-Snapshot ist genau die Grundlage, die durch die
  // Stammdatenänderung ersetzt wird. Bei Wiederverwendung eines offenen
  // Checks bleiben dessen unveränderlicher Startanlass und seine Linie intakt.
  const terminalPredecessor = await tx.gwgCheck.findFirst({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: { in: ['VERIFIED', 'REJECTED', 'EXPIRED'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: GWG_SNAPSHOT_COPY_INCLUDE,
  });

  const invalidated = await tx.gwgCheck.updateMany({
    where: { clientId: input.clientId, status: 'VERIFIED' },
    data: { status: 'EXPIRED' },
  });

  const deactivated = await tx.client.updateMany({
    where: { id: input.clientId, tenantId: input.tenantId, allowActive: true },
    data: { allowActive: false },
  });

  const existing = await tx.gwgCheck.findFirst({
    where: { clientId: input.clientId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true },
  });
  const invalidatedIdentityDocuments = existing
    ? await tx.gwgIdDocument.updateMany({
        where: {
          gwgCheckId: existing.id,
          type: { in: ['PERSONALAUSWEIS', 'REISEPASS'] },
          supersededAt: null,
        },
        data: {
          naturalClientSubjectId: null,
          beneficialOwnerSubjectId: null,
          representativeSubjectId: null,
          identityAssignmentConfirmedAt: null,
          identityAssignmentConfirmedBy: null,
          verifiedAt: null,
        },
      })
    : { count: 0 };
  let review: { id: string };
  if (existing) {
    review = await tx.gwgCheck.update({
      where: { id: existing.id },
      data: {
        status: 'DRAFT',
        reviewSubmittedAt: null,
        reviewSubmittedBy: null,
        riskLevel: null,
        riskScore: null,
        riskAnswers: Prisma.DbNull,
        riskBreakdown: Prisma.DbNull,
      },
      select: { id: true },
    });
    // Eine frühere Freigabeanforderung ist mit dem Rücksprung nach DRAFT nicht
    // mehr handlungsfähig. Sie jetzt zu schließen ist auch für den nächsten
    // Submit wichtig: Dann steigt der Unread-Zähler wieder, statt eine alte
    // offene Notification nur in-place auf denselben Check zu aktualisieren.
    await resolveNotificationsTx(tx, {
      tenantId: input.tenantId,
      resources: [{ resourceType: 'gwg_check', resourceId: existing.id }],
      hrefs: [`/staff/clients/${input.clientId}/gwg`],
      kinds: ['GWG_ONBOARDING_SUBMITTED'],
    });
  } else {
    review = await createFreshGwgDraftTx(tx, {
      ...input,
      predecessorCheckId: terminalPredecessor?.id ?? null,
      changeScope: terminalPredecessor ? 'CLIENT_MASTER_DATA' : 'INITIAL',
    });
    await copyGwgSnapshotTx(tx, {
      ...input,
      targetCheckId: review.id,
      source: terminalPredecessor,
    });
  }

  return {
    invalidatedChecks: invalidated.count,
    invalidatedIdentityDocuments: invalidatedIdentityDocuments.count,
    reviewCheckId: review.id,
    // Der DB-Trigger kann bereits beim Statuswechsel deaktiviert haben; dann
    // trifft das explizite updateMany keine Zeile mehr.
    clientDeactivated: invalidated.count > 0 || deactivated.count > 0,
  };
}

/**
 * Ein öffentlicher Onboarding-Submit erzeugt IMMER einen frischen Snapshot.
 * So kann ein alter/verifizierter Check weder in-place zurückgesetzt noch durch
 * deleteMany seiner Berechtigten/Ausweise zerstört werden. Bestehende
 * Alle älteren offenen oder verifizierten Prüfungen werden terminal markiert
 * und der Mandant fail-closed. Sonst könnte ein bereits geöffneter Staff-Tab
 * den älteren IN_REVIEW-Snapshot nach dem neuen Submit noch verifizieren.
 */
export async function startFreshGwgReviewTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    predecessorCheckId?: string | null;
    changeScope?: GwgChangeScopeInput;
  },
): Promise<ReverificationResult & { reviewCheckId: string }> {
  await lockGwgCheckLifecycleTx(tx, input);

  const review = await createFreshGwgDraftTx(tx, input);
  const invalidated = await tx.gwgCheck.updateMany({
    where: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: { in: ['DRAFT', 'IN_REVIEW', 'VERIFIED'] },
      id: { not: review.id },
    },
    data: { status: 'EXPIRED' },
  });
  const deactivated = await tx.client.updateMany({
    where: { id: input.clientId, tenantId: input.tenantId, allowActive: true },
    data: { allowActive: false },
  });

  return {
    invalidatedChecks: invalidated.count,
    invalidatedIdentityDocuments: 0,
    reviewCheckId: review.id,
    clientDeactivated: invalidated.count > 0 || deactivated.count > 0,
  };
}

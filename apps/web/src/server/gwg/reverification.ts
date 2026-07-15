import type { TxClient } from '@taxtronik/db';

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
  input: { tenantId: string; clientId: string },
): Promise<{ id: string }> {
  const createdAt = await nextGwgCheckCreatedAtTx(tx, input);
  return tx.gwgCheck.create({
    data: {
      tenantId: input.tenantId,
      clientId: input.clientId,
      status: 'DRAFT',
      createdAt,
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
  const review = existing
    ? await tx.gwgCheck.update({
        where: { id: existing.id },
        data: { status: 'DRAFT', reviewSubmittedAt: null, reviewSubmittedBy: null },
        select: { id: true },
      })
    : await createFreshGwgDraftTx(tx, input);

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
  input: { tenantId: string; clientId: string },
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

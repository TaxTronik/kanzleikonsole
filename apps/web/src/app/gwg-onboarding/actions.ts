'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import {
  commitPreparedBytes,
  deleteObjectVersion,
  MAX_UPLOAD_BYTES,
  prepareBytesCommitWithTier,
  type CommitDocumentResult,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { withSystemContext, type TxClient } from '@taxtronik/db';
import {
  createPendingDocumentWithVersion,
  finalizePendingDocumentVersion,
} from '@/server/documents/upload-helpers';
import { toActionError } from '@/server/auth/rbac';
import {
  expireOpenInviteIfDue,
  GENERIC_TOKEN_ERROR,
  hashInviteToken,
  prismaOwner,
} from '@/server/gwg-onboarding/service';
import { checkRateLimit, checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';
import { log } from '@/server/logger';
import { PortalConsentSelectionsSchema } from '@/server/privacy/consent';
import {
  ConsentDisplayChangedError,
  RequiredConsentOptionsError,
} from '@/server/privacy/consent-catalog';
import { CONSENT_DISPLAY_CHANGED_MESSAGE } from '@/server/privacy/consent-display';
import { revalidateOpenGwgInviteRevisionTx } from '@/server/gwg-onboarding/invite-lifecycle';
import { GwgOnboardingOwnerSchema } from '@/server/gwg-onboarding/owner-submission';
import { GwgOnboardingLegalEntityDeclarationSchema } from '@/server/gwg-onboarding/legal-entity-submission';
import {
  GwgOnboardingLocalPersonIdSchema,
  GwgOnboardingRepresentativeSchema,
} from '@/server/gwg-onboarding/representative-submission';
import { validateOnboardingSubmission } from '@/server/gwg-onboarding/submission-validation';
import { OnboardingIdentitySetConflictError } from '@/server/gwg-onboarding/identity-persistence';
import {
  BoundInviteDraftChangedError,
  runOnboardingSubmissionTransactionTx,
} from '@/server/gwg-onboarding/submission-transaction';
import {
  ensureGwgPersonFolderTx,
  ensureGwgRootFolderTx,
} from '@/server/gwg-onboarding/document-folders';

// M4: GwG-Uploads sind enger gecappt als der globale MAX_UPLOAD_BYTES (25 MiB).
// Ausweis-Scans sind typischerweise ≤5 MB; 10 MB ist großzügig für hochauflösende
// PDFs. Das base64-Limit entspricht binär ~7.5 MB; binäre Prüfung darunter
// erzwingt die echte Grenze.
const GWG_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// base64-overhead: 4 chars pro 3 bytes → 10 MB binär = ~13.4 MB base64.
// 14 MB Schema-Limit schützt vor Memory-DOS durch Parsing übergroßer base64.
const GWG_BASE64_MAX_CHARS = 14 * 1024 * 1024;

export interface ActionResult {
  ok: boolean;
  error?: string;
  documentId?: string;
}

class InviteUploadStateChangedError extends Error {}
class InviteSupersededError extends Error {}
class OnboardingDocumentDiscardError extends Error {}

// ----------------------------------------------------------------------------
// Befund 6: Fehler-Mapping für diesen anonymen (Token-)Endpoint. Rohe Prisma-/
// Storage-Meldungen dürfen nicht an Unauthentifizierte durchgereicht werden.
// Bekannte fachliche Fehler → verständliche deutsche Meldung; alles andere
// läuft durch das zentrale toActionError (generische Meldung + strukturiertes
// Server-Log).
// ----------------------------------------------------------------------------
function toAnonymousActionError(e: unknown): ActionResult {
  const msg = (e as Error)?.message ?? '';
  if (msg.startsWith('INFECTED')) {
    return { ok: false, error: 'Die Datei wurde vom Virenscanner abgewiesen.' };
  }
  if (msg.startsWith('TOO_LARGE')) {
    return { ok: false, error: 'Die Datei ist zu groß.' };
  }
  if (msg.startsWith('SCAN_ERROR')) {
    return {
      ok: false,
      error: 'Der Virenscan ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.',
    };
  }
  if (msg === 'PRIVACY_CONFIG_INCOMPLETE') {
    return {
      ok: false,
      error:
        'Die Datenschutzhinweise der Kanzlei sind noch unvollständig. Bitte wenden Sie sich an die Kanzlei.',
    };
  }
  if (e instanceof RequiredConsentOptionsError) {
    return { ok: false, error: e.message };
  }
  if (e instanceof ConsentDisplayChangedError) {
    return { ok: false, error: e.message };
  }
  if (e instanceof InviteUploadStateChangedError) {
    return {
      ok: false,
      error:
        'Die Einladung wurde zwischenzeitlich abgeschlossen oder ist abgelaufen. Die Datei wurde nicht zugeordnet.',
    };
  }
  if (e instanceof OnboardingDocumentDiscardError) {
    return {
      ok: false,
      error: 'Die Datei konnte nicht entfernt werden. Bitte versuchen Sie es erneut.',
    };
  }
  if (e instanceof InviteSupersededError) {
    return {
      ok: false,
      error: 'Diese Einladung wurde durch einen neueren Link ersetzt und ist nicht mehr gültig.',
    };
  }
  if (e instanceof BoundInviteDraftChangedError) {
    return {
      ok: false,
      error:
        'Der GwG-Datenstand wurde zwischenzeitlich geändert. Bitte fordern Sie bei Ihrer Kanzlei eine neue Einladung an.',
    };
  }
  if (e instanceof OnboardingIdentitySetConflictError) {
    return {
      ok: false,
      error:
        'Der GwG-Datenstand wurde zwischenzeitlich geändert. Bitte fordern Sie bei Ihrer Kanzlei eine neue Einladung an.',
    };
  }
  return toActionError(e);
}

// ----------------------------------------------------------------------------
// Token-Lookup (gemeinsam für Upload + Submit)
// ----------------------------------------------------------------------------

async function loadInviteForWrite(rawToken: string) {
  const tokenHash = hashInviteToken(rawToken);
  const inv = await prismaOwner.gwgOnboardingInvite.findFirst({
    where: { tokenHash },
    include: {
      client: true,
      gwgCheck: {
        select: {
          idDocuments: { select: { documentId: true } },
        },
      },
    },
  });
  if (!inv) throw new Error(GENERIC_TOKEN_ERROR);
  if (inv.status === 'CANCELLED' || inv.status === 'EXPIRED') {
    throw new Error(GENERIC_TOKEN_ERROR);
  }
  if (inv.status === 'SUBMITTED') {
    throw new Error(GENERIC_TOKEN_ERROR);
  }
  const now = new Date();
  if (inv.expiresAt.getTime() <= now.getTime()) {
    await expireOpenInviteIfDue(inv.id, now);
    throw new Error(GENERIC_TOKEN_ERROR);
  }
  return inv;
}

// ----------------------------------------------------------------------------
// Datei-Upload (Token-authentifiziert)
// ----------------------------------------------------------------------------

const UploadSchema = z.object({
  token: z.string().min(10),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  base64: z.string().min(1).max(GWG_BASE64_MAX_CHARS),
  kind: z.enum(['ID_DOCUMENT', 'EXTRA']),
  personName: z.string().max(200).optional(),
});

export async function uploadIdImageAction(input: {
  token: string;
  fileName: string;
  mimeType: string;
  base64: string;
  kind: 'ID_DOCUMENT' | 'EXTRA';
  personName?: string;
}): Promise<ActionResult> {
  const parsed = UploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { token, fileName, mimeType, base64, kind, personName } = parsed.data;

  // H2: Rate-Limit gegen Sättigung von Storage + ClamAV-Backend. Pro IP
  // und pro Token getrennt — ein böser Token-Inhaber soll andere Mandanten
  // nicht ausbremsen können, eine bösartige IP nicht mehrere Tokens parallel
  // missbrauchen. 20 Uploads pro 10 Min ist großzügig für ein Onboarding
  // (typisch 4-8 Dateien), aber bremst ein Skript hart.
  const ip = getClientIp(await headers());
  const ipRl = await checkIpOrGlobalLimit(
    'gwg-upload-ip',
    ip,
    { max: 30, windowSec: 600 },
    { max: 200, windowSec: 600 },
  );
  if (!ipRl.ok) {
    return {
      ok: false,
      error: `Zu viele Uploads. Bitte ${Math.ceil(ipRl.retryAfter / 60)} Min. warten.`,
    };
  }
  const tokenRl = await checkRateLimit(`gwg-upload-token:${hashInviteToken(token).slice(0, 16)}`, {
    max: 20,
    windowSec: 600,
  });
  if (!tokenRl.ok) {
    return {
      ok: false,
      error: `Zu viele Uploads für diese Einladung. Bitte ${Math.ceil(tokenRl.retryAfter / 60)} Min. warten.`,
    };
  }

  let invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
  try {
    invite = await loadInviteForWrite(token);
  } catch {
    // Der anonyme Token-Pfad darf weder Lifecycle-Zustände noch rohe
    // Datenbankfehler unterscheiden lassen.
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  const tokenHash = hashInviteToken(token);
  const revisionCurrent = await withSystemContext(invite.tenantId, (tx) =>
    revalidateOpenGwgInviteRevisionTx(tx, {
      inviteId: invite.id,
      tenantId: invite.tenantId,
      clientId: invite.clientId,
      tokenHash,
      now: new Date(),
    }),
  );
  if (!revisionCurrent) return { ok: false, error: GENERIC_TOKEN_ERROR };

  const fileData = Buffer.from(base64, 'base64');
  if (fileData.length > GWG_UPLOAD_MAX_BYTES) {
    return { ok: false, error: `Datei zu groß (max. ${GWG_UPLOAD_MAX_BYTES / (1024 * 1024)} MB).` };
  }
  // Defense in Depth: globaler Cap aus dem Storage-Service spiegelt das
  // Limit von commitDocumentFromBytes. Sollte beim GwG-Pfad nie greifen
  // (GwG-Cap ist enger), aber falls jemand das GwG-Limit hochsetzt ohne
  // den globalen anzupassen, fängt der globale Cap es ab.
  if (fileData.length > MAX_UPLOAD_BYTES) {
    return { ok: false, error: 'Datei überschreitet das globale Upload-Limit.' };
  }

  // Eigene GwG-Klassifikation: reguläre Aufbewahrung fünf Jahre nach § 8 Abs. 4
  // GwG; ausdrücklich nicht pauschal als GoBD-Beleg/10-Jahres-Objekt behandeln.
  const classification = 'GWG_EVIDENCE';

  let documentId: string;
  let prepared: PreparedBytesCommit | null = null;
  let pendingDocumentId: string | null = null;
  let pendingVersionId: string | null = null;
  let stored: CommitDocumentResult | null = null;
  try {
    prepared = await prepareBytesCommitWithTier({
      fileData,
      tier: 'GWG',
      classification,
      tenantId: invite.tenantId,
    });

    // Der feste Bucket/Key und Hash werden vor dem ersten S3-PUT dauerhaft
    // journalisiert. Auch ein Prozessabbruch nach dem PUT hinterlässt damit
    // niemals unauffindbare geschützte GwG-Bytes im Object Store.
    const pending = await withSystemContext(invite.tenantId, async (tx) => {
      const inviteStillOpen = await revalidateOpenGwgInviteRevisionTx(tx, {
        inviteId: invite.id,
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        tokenHash,
        now: new Date(),
      });
      if (!inviteStillOpen) throw new InviteUploadStateChangedError();
      const gwgFolderId = await ensureGwgRootFolderTx(tx, {
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        createdByStaff: invite.createdByStaff,
      });
      const targetFolderId =
        kind === 'ID_DOCUMENT' && personName?.trim()
          ? await ensureGwgPersonFolderTx(tx, {
              tenantId: invite.tenantId,
              clientId: invite.clientId,
              rootFolderId: gwgFolderId,
              personName,
              createdByStaff: invite.createdByStaff,
            })
          : gwgFolderId;
      return createPendingDocumentWithVersion(tx, {
        documentData: {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          title: fileName,
          classification,
          gwgOnboardingInviteId: invite.id,
          folderId: targetFolderId,
          mimeType: prepared!.detectedMime ?? mimeType,
        },
        prepared: prepared!,
        createdById: invite.createdByStaff,
      });
    });
    pendingDocumentId = pending.document.id;
    pendingVersionId = pending.version.id;

    stored = await commitPreparedBytes({ fileData, prepared });

    // Finalisierung, Audit und Invite-Zuordnung werden gemeinsam committed.
    documentId = await withSystemContext(invite.tenantId, async (tx) => {
      const inviteStillOpen = await revalidateOpenGwgInviteRevisionTx(tx, {
        inviteId: invite.id,
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        tokenHash,
        now: new Date(),
      });
      if (!inviteStillOpen) throw new InviteUploadStateChangedError();

      await finalizePendingDocumentVersion(tx, {
        documentId: pendingDocumentId!,
        versionId: pendingVersionId!,
        commit: stored!,
      });
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: kind === 'ID_DOCUMENT' ? 'gwg.onboarding.upload.id' : 'gwg.onboarding.upload.extra',
        resourceType: 'document',
        resourceId: pendingDocumentId!,
        after: { fileName, mimeType, inviteId: invite.id, kind },
      });
      // Liste und Document werden zusammen committed, waehrend der Invite bis
      // zum Transaktionsende FOR UPDATE gesperrt bleibt. Ein Submit sieht
      // damit entweder den kompletten Upload oder wartet und laeuft danach.
      await tx.$executeRaw`
        UPDATE gwg_onboarding_invite
        SET uploaded_document_ids = uploaded_document_ids || ${JSON.stringify([pendingDocumentId])}::jsonb,
            status = CASE
              WHEN status = 'PENDING'::gwg_invite_status THEN 'STARTED'::gwg_invite_status
              ELSE status
            END
        WHERE id = ${invite.id}::uuid
      `;
      return pendingDocumentId!;
    });
  } catch (e) {
    // Ein Fehler beim COMMIT-ACK der finalen DB-Transaktion ist mehrdeutig: Die
    // Version kann bereits mitsamt Audit und Invite-Zuordnung committed sein.
    // Deshalb darf das geschützte Objekt erst nach einem erneuten, eindeutigen
    // Lesen der dauerhaft journalisierten Version kompensierend gelöscht werden.
    let objectPhysicallyAbsent = false;
    if (stored?.storageVersionId && pendingDocumentId && pendingVersionId) {
      let storedObjectCanBeDeleted = false;
      try {
        const persistedVersion = await withSystemContext(invite.tenantId, (tx) =>
          tx.documentVersion.findUnique({
            where: { id: pendingVersionId! },
            select: {
              documentId: true,
              storageBucket: true,
              storageKey: true,
              storageVersionId: true,
              scanStatus: true,
            },
          }),
        );
        const sameJournalIntent =
          persistedVersion?.documentId === pendingDocumentId &&
          persistedVersion.storageBucket === stored.targetBucket &&
          persistedVersion.storageKey === stored.targetKey;

        if (
          sameJournalIntent &&
          persistedVersion.scanStatus === 'CLEAN' &&
          persistedVersion.storageVersionId === stored.storageVersionId
        ) {
          log.warn(
            {
              component: 'gwg-onboarding-upload',
              inviteId: invite.id,
              tenantId: invite.tenantId,
              documentId: pendingDocumentId,
            },
            'GwG onboarding upload recovered after ambiguous database commit response',
          );
          return { ok: true, documentId: pendingDocumentId };
        }

        storedObjectCanBeDeleted =
          sameJournalIntent &&
          persistedVersion.scanStatus === 'PENDING' &&
          persistedVersion.storageVersionId === null;
      } catch (reconciliationError) {
        // Bei einem Read-Fehler bleibt die journalisierte Absicht samt Objekt
        // erhalten. Ohne belastbaren DB-Zustand ist eine Löschung nicht sicher.
        log.error(
          {
            component: 'gwg-onboarding-upload',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            pendingDocumentId,
            reconciliationErr: (reconciliationError as Error).message,
          },
          'GwG onboarding upload reconciliation failed',
        );
      }

      if (storedObjectCanBeDeleted) {
        try {
          await deleteObjectVersion(
            stored.targetBucket,
            stored.targetKey,
            stored.storageVersionId,
            {
              bypassGovernanceRetention: true,
            },
          );
          objectPhysicallyAbsent = true;
        } catch (cleanupError) {
          log.error(
            {
              component: 'gwg-onboarding-upload',
              inviteId: invite.id,
              tenantId: invite.tenantId,
              orphanedBucket: stored.targetBucket,
              orphanedKey: stored.targetKey,
              cleanupErr: (cleanupError as Error).message,
            },
            'GwG onboarding upload compensation failed',
          );
        }
      }
    }
    // Das PENDING-Journal bleibt erhalten, wenn die physische Löschung nicht
    // nachgewiesen ist. So kann Ops die konkrete Bucket/Key/Hash-Absicht
    // wiederaufnehmen. Nur bei nachweislich fehlendem Objekt darf die leere
    // DB-Absicht kompensierend verschwinden.
    if (pendingDocumentId && objectPhysicallyAbsent) {
      try {
        await withSystemContext(invite.tenantId, (tx) =>
          tx.document.deleteMany({
            where: {
              id: pendingDocumentId!,
              tenantId: invite.tenantId,
              versions: {
                every: { scanStatus: 'PENDING', storageVersionId: null },
              },
            },
          }),
        );
      } catch (cleanupError) {
        log.error(
          {
            component: 'gwg-onboarding-upload',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            pendingDocumentId,
            cleanupErr: (cleanupError as Error).message,
          },
          'GwG onboarding upload pending journal cleanup failed',
        );
      }
    }
    // Befund 6: kein Durchreichen roher Prisma-/Storage-Meldungen an Anonyme.
    const err = e as Error;
    log.error(
      {
        component: 'gwg-onboarding-upload',
        kind,
        inviteId: invite.id,
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        mimeType,
        sizeBytes: fileData.length,
        name: err?.name,
        err: err?.message,
        stack: err?.stack,
      },
      'GwG onboarding upload failed',
    );
    return toAnonymousActionError(e);
  }

  return { ok: true, documentId };
}

// ----------------------------------------------------------------------------
// Verwerfen eines versehentlichen Uploads (nur offener Invite, noch ungebunden)
// ----------------------------------------------------------------------------

const DiscardUploadSchema = z.object({
  token: z.string().min(10),
  documentId: z.string().uuid(),
});

interface DiscardableDocumentVersion {
  title: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
}

async function discardOpenInviteDocumentTx(
  tx: TxClient,
  input: {
    invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
    tokenHash: string;
    documentId: string;
    deleteStoredObject: boolean;
    onStoredObjectDeleted?: () => void;
  },
): Promise<'DISCARDED' | 'ALREADY_DISCARDED'> {
  const { invite, tokenHash, documentId } = input;
  const inviteStillOpen = await revalidateOpenGwgInviteRevisionTx(tx, {
    inviteId: invite.id,
    tenantId: invite.tenantId,
    clientId: invite.clientId,
    tokenHash,
    now: new Date(),
  });
  if (!inviteStillOpen) throw new InviteUploadStateChangedError();

  const versions = await tx.$queryRaw<DiscardableDocumentVersion[]>`
    SELECT d.title,
           dv.storage_bucket AS "storageBucket",
           dv.storage_key AS "storageKey",
           dv.storage_version_id AS "storageVersionId"
      FROM document d
      JOIN document_version dv ON dv.document_id = d.id
     WHERE d.id = ${documentId}::uuid
       AND d.tenant_id = ${invite.tenantId}::uuid
       AND d.client_id = ${invite.clientId}::uuid
       AND d.gwg_onboarding_invite_id = ${invite.id}::uuid
       AND d.classification = 'GWG_EVIDENCE'
       AND d.deleted_at IS NULL
       AND d.gwg_destruction_requested_at IS NULL
       AND d.gwg_destroyed_at IS NULL
       AND dv.immutable = TRUE
       AND dv.scan_status = 'CLEAN'
       AND dv.storage_version_id IS NOT NULL
       AND btrim(dv.storage_version_id) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM gwg_id_document gid WHERE gid.document_id = d.id
       )
     ORDER BY dv.version_no
     FOR UPDATE OF d, dv
  `;

  if (versions.length === 0) {
    const current = await tx.gwgOnboardingInvite.findUnique({
      where: { id: invite.id },
      select: { uploadedDocumentIds: true },
    });
    const stillListed =
      Array.isArray(current?.uploadedDocumentIds) &&
      current.uploadedDocumentIds.includes(documentId);
    if (!stillListed) return 'ALREADY_DISCARDED';
    throw new OnboardingDocumentDiscardError();
  }
  if (versions.length !== 1) throw new OnboardingDocumentDiscardError();

  const version = versions[0];
  if (!version) throw new OnboardingDocumentDiscardError();
  if (input.deleteStoredObject) {
    await deleteObjectVersion(version.storageBucket, version.storageKey, version.storageVersionId, {
      bypassGovernanceRetention: true,
    });
    input.onStoredObjectDeleted?.();
  }

  const discarded = await tx.$queryRaw<Array<{ discarded: number }>>`
    SELECT app.discard_open_gwg_onboarding_document(
      ${invite.id}::uuid,
      ${documentId}::uuid
    ) AS discarded
  `;
  if (discarded[0]?.discarded !== 1) throw new OnboardingDocumentDiscardError();

  await evidenceService.record(tx, {
    tenantId: invite.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: null,
    action: 'gwg.onboarding.upload.discard',
    resourceType: 'document',
    resourceId: documentId,
    before: { title: version.title, inviteId: invite.id },
    after: { discarded: true },
  });
  return 'DISCARDED';
}

export async function discardOnboardingUploadAction(input: {
  token: string;
  documentId: string;
}): Promise<ActionResult> {
  const parsed = DiscardUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { token, documentId } = parsed.data;

  const tokenRl = await checkRateLimit(`gwg-discard-token:${hashInviteToken(token).slice(0, 16)}`, {
    max: 40,
    windowSec: 600,
  });
  if (!tokenRl.ok) {
    return { ok: false, error: 'Zu viele Löschversuche. Bitte kurz warten.' };
  }

  let invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
  try {
    invite = await loadInviteForWrite(token);
  } catch {
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  const tokenHash = hashInviteToken(token);
  let storedObjectDeleted = false;
  try {
    const result = await withSystemContext(invite.tenantId, async (tx) => {
      const outcome = await discardOpenInviteDocumentTx(tx, {
        invite,
        tokenHash,
        documentId,
        deleteStoredObject: true,
        onStoredObjectDeleted: () => {
          storedObjectDeleted = true;
        },
      });
      return outcome;
    });
    void result;
    return { ok: true };
  } catch (error) {
    // Nach einem erfolgreichen Object-Store-Delete kann die DB-Antwort
    // mehrdeutig sein. Ein zweiter, idempotenter Lauf ohne erneutes S3-Delete
    // bringt Invite-Liste, Audit und DB-Zeilen wieder in einen konsistenten
    // Zustand, oder erkennt einen bereits vollständig committeden Erstlauf.
    if (storedObjectDeleted) {
      try {
        await withSystemContext(invite.tenantId, (tx) =>
          discardOpenInviteDocumentTx(tx, {
            invite,
            tokenHash,
            documentId,
            deleteStoredObject: false,
          }),
        );
        return { ok: true };
      } catch (recoveryError) {
        log.error(
          {
            component: 'gwg-onboarding-discard',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            documentId,
            recoveryErr: (recoveryError as Error).message,
          },
          'GwG onboarding discard reconciliation failed',
        );
      }
    }
    log.error(
      {
        component: 'gwg-onboarding-discard',
        inviteId: invite.id,
        tenantId: invite.tenantId,
        documentId,
        err: (error as Error).message,
      },
      'GwG onboarding discard failed',
    );
    return toAnonymousActionError(error);
  }
}

// ----------------------------------------------------------------------------
// Submit (alle Stammdaten + Owner + Dokumente in GwG-Tabellen schreiben)
// ----------------------------------------------------------------------------

const SubmitSchema = z.object({
  token: z.string().min(10),
  master: z.object({
    companyName: z.string().min(1).max(200),
    street: z.string().min(1).max(255),
    postalCode: z.string().min(1).max(20),
    city: z.string().min(1).max(100),
    countryIso: z.string().min(2).max(10),
    vatId: z.string().max(20).optional().or(z.literal('')),
  }),
  legalEntity: GwgOnboardingLegalEntityDeclarationSchema,
  owners: z
    .array(GwgOnboardingOwnerSchema.extend({ localId: GwgOnboardingLocalPersonIdSchema }))
    .min(1)
    .max(50),
  representatives: z.array(GwgOnboardingRepresentativeSchema).max(50).default([]),
  extraDocuments: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        type: z.enum([
          'HANDELSREGISTERAUSZUG',
          'GESELLSCHAFTSVERTRAG',
          'TRANSPARENZREGISTER_AUSZUG',
          'VOLLMACHT',
          'SONSTIGES',
        ]),
      }),
    )
    .max(20),
  // Datenschutz-Einwilligungen (Teil B) + Bestätigung der Hinweise (Teil A).
  consent: z.object({
    noticeAcknowledged: z.literal(true),
    signedByName: z.string().min(1).max(300),
    selections: PortalConsentSelectionsSchema,
    displayRevision: z
      .string({ error: CONSENT_DISPLAY_CHANGED_MESSAGE })
      .regex(/^[a-f0-9]{64}$/, CONSENT_DISPLAY_CHANGED_MESSAGE),
  }),
});

export async function submitOnboardingAction(
  input: z.infer<typeof SubmitSchema>,
): Promise<ActionResult> {
  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const { token, master, owners } = parsed.data;

  const h = await headers();
  const ip = getClientIp(h);
  const ua = h.get('user-agent') ?? null;

  // H2: Rate-Limit auf Submit (≤5/min pro Token) — Spam-Schutz gegen
  // automatisiertes Replay nach Token-Leak.
  const submitRl = await checkRateLimit(`gwg-submit-token:${hashInviteToken(token).slice(0, 16)}`, {
    max: 5,
    windowSec: 60,
  });
  if (!submitRl.ok) {
    return { ok: false, error: 'Zu viele Submit-Versuche. Bitte kurz warten.' };
  }

  let invite: Awaited<ReturnType<typeof loadInviteForWrite>>;
  try {
    invite = await loadInviteForWrite(token);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const preflight = validateOnboardingSubmission({
    clientKind: invite.client.kind,
    uploadedDocumentIds: invite.uploadedDocumentIds,
    existingCheckDocumentIds: invite.gwgCheck?.idDocuments.map((entry) => entry.documentId) ?? [],
    owners,
    representatives: parsed.data.representatives,
    extraDocuments: parsed.data.extraDocuments,
    legalEntity: parsed.data.legalEntity,
  });
  if (!preflight.ok) return { ok: false, error: preflight.error };
  const { linkedOwnerLocalIds } = preflight;

  try {
    const submitResult = await withSystemContext(invite.tenantId, (tx) =>
      runOnboardingSubmissionTransactionTx(tx, {
        invite: {
          id: invite.id,
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          gwgCheckId: invite.gwgCheckId,
          clientKind: invite.client.kind,
          createdByStaff: invite.createdByStaff,
        },
        tokenHash: hashInviteToken(token),
        submittedIp: ip,
        submittedUserAgent: ua,
        linkedOwnerLocalIds,
        master,
        legalEntity: parsed.data.legalEntity,
        owners,
        representatives: parsed.data.representatives,
        extraDocuments: parsed.data.extraDocuments,
        consent: parsed.data.consent,
      }),
    );
    if (!submitResult.ok) {
      if (submitResult.reason === 'SUPERSEDED') throw new InviteSupersededError();
      if (submitResult.reason === 'STALE') throw new BoundInviteDraftChangedError();
      throw new Error(
        'Einladung wurde bereits abgeschickt, ist abgelaufen oder nicht mehr gültig.',
      );
    }
  } catch (e) {
    // Befund 6: kein Durchreichen roher Prisma-/DB-Meldungen an Anonyme.
    return toAnonymousActionError(e);
  }

  return { ok: true };
}

'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { headers } from 'next/headers';
import { Prisma } from '@prisma/client';
import {
  commitPreparedBytes,
  deleteObjectVersion,
  MAX_UPLOAD_BYTES,
  prepareBytesCommitWithTier,
  type CommitDocumentResult,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { withSystemContext } from '@taxtronik/db';
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
import { notifyMany } from '@/server/notifications/service';
import { PortalConsentSelectionsSchema, countGranted } from '@/server/privacy/consent';
import {
  ConsentDisplayChangedError,
  RequiredConsentOptionsError,
  resolveConsentSelectionsTx,
} from '@/server/privacy/consent-catalog';
import { lockConsentCatalogTx } from '@/server/privacy/catalog-lock';
import { CONSENT_DISPLAY_CHANGED_MESSAGE } from '@/server/privacy/consent-display';
import { renderNoticeForTenantTx } from '@/server/privacy/service';
import { startFreshGwgReviewTx } from '@/server/gwg/reverification';
import {
  claimCurrentGwgInviteSubmitTx,
  revalidateOpenGwgInviteRevisionTx,
} from '@/server/gwg-onboarding/invite-lifecycle';
import {
  canStartUnboundGwgInviteTx,
  resolveBoundGwgInviteDraftTx,
} from '@/server/gwg-onboarding/bound-review';
import {
  GwgOnboardingOwnerSchema,
  toBeneficialOwnerSnapshot,
} from '@/server/gwg-onboarding/owner-submission';
import {
  GwgOnboardingLegalEntityDeclarationSchema,
  legalEntityEvidenceError,
} from '@/server/gwg-onboarding/legal-entity-submission';
import {
  GwgOnboardingLocalPersonIdSchema,
  GwgOnboardingRepresentativeSchema,
  onboardingRepresentativeRoleError,
} from '@/server/gwg-onboarding/representative-submission';

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
class BoundInviteDraftChangedError extends Error {}

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
});

export async function uploadIdImageAction(input: {
  token: string;
  fileName: string;
  mimeType: string;
  base64: string;
  kind: 'ID_DOCUMENT' | 'EXTRA';
}): Promise<ActionResult> {
  const parsed = UploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { token, fileName, mimeType, base64, kind } = parsed.data;

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
      return createPendingDocumentWithVersion(tx, {
        documentData: {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          title: fileName,
          classification,
          gwgOnboardingInviteId: invite.id,
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
          await deleteObjectVersion(stored.targetBucket, stored.targetKey, stored.storageVersionId, {
            bypassGovernanceRetention: true,
          });
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

  const ownerLocalIds = new Set(owners.map((owner) => owner.localId));
  if (ownerLocalIds.size !== owners.length) {
    return { ok: false, error: 'Wirtschaftlich Berechtigte enthalten doppelte Personen-IDs.' };
  }
  const representativeRoleError = onboardingRepresentativeRoleError(
    invite.client.kind,
    ownerLocalIds,
    parsed.data.representatives,
  );
  if (representativeRoleError) return { ok: false, error: representativeRoleError };
  const linkedOwnerLocalIds = parsed.data.representatives.flatMap((representative) =>
    representative.linkedOwnerLocalId ? [representative.linkedOwnerLocalId] : [],
  );

  // H-1: alle referenzierten Document-IDs müssen über DIESES Invite
  // hochgeladen worden sein. Sonst könnte ein Angreifer beim Submit fremde
  // document.id-UUIDs einreihen — FK greift nur auf Existenz, nicht Tenant.
  const allowedDocIds = new Set([
    ...(Array.isArray(invite.uploadedDocumentIds) ? (invite.uploadedDocumentIds as string[]) : []),
    ...(invite.gwgCheck?.idDocuments.flatMap((entry) =>
      entry.documentId ? [entry.documentId] : [],
    ) ?? []),
  ]);
  const referencedDocIds: string[] = [
    ...parsed.data.owners.flatMap((o) => [o.idFrontDocumentId, o.idBackDocumentId]),
    ...parsed.data.representatives.flatMap((representative) =>
      representative.linkedOwnerLocalId
        ? []
        : [representative.idFrontDocumentId, representative.idBackDocumentId].filter(
            (documentId): documentId is string => Boolean(documentId),
          ),
    ),
    ...parsed.data.extraDocuments.map((document) => document.documentId),
  ];
  for (const docId of referencedDocIds) {
    if (!allowedDocIds.has(docId)) {
      return {
        ok: false,
        error: 'Referenziertes Dokument wurde nicht über diesen Onboarding-Link hochgeladen.',
      };
    }
  }
  if (new Set(referencedDocIds).size !== referencedDocIds.length) {
    return { ok: false, error: 'Ein Dokument darf nur einmal zugeordnet werden.' };
  }
  const entityEvidenceError = legalEntityEvidenceError(
    invite.client.kind,
    parsed.data.legalEntity,
    new Set(parsed.data.extraDocuments.map((document) => document.type)),
  );
  if (entityEvidenceError) {
    return { ok: false, error: entityEvidenceError };
  }

  try {
    const submitResult = await withSystemContext(invite.tenantId, async (tx) => {
      // Der Mandanten-Lifecycle-Lock liegt vor dem atomaren Einmal-Claim. Nur
      // die aktuellste Einladung darf gewinnen; bei Erfolg werden alle anderen
      // offenen Links in derselben Tx entwertet. Jeder spätere Fehler rollt
      // Claim und Supersession gemeinsam zurück.
      const claim = await claimCurrentGwgInviteSubmitTx(tx, {
        tenantId: invite.tenantId,
        clientId: invite.clientId,
        inviteId: invite.id,
        tokenHash: hashInviteToken(token),
        submittedIp: ip,
        submittedUa: ua,
      });
      if (!claim.ok) {
        return { ok: false, reason: claim.reason } as const;
      }

      // Die CAS-Pruefung muss vor jeder Client-/GwG-Mutation liegen. Andernfalls
      // koennte das Portal zuerst alte Masterdaten zurueckschreiben und damit
      // den bei Einladungsausgabe gespeicherten Hash scheinbar wiederherstellen.
      let review;
      if (invite.gwgCheckId) {
        const boundDraft = await resolveBoundGwgInviteDraftTx(tx, {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          inviteId: invite.id,
          expectedCheckId: invite.gwgCheckId,
        });
        if (!boundDraft) throw new BoundInviteDraftChangedError();
        review = {
          invalidatedChecks: 0,
          invalidatedIdentityDocuments: 0,
          reviewCheckId: boundDraft.id,
          clientDeactivated: false,
        };
      } else {
        if (
          !(await canStartUnboundGwgInviteTx(tx, {
            tenantId: invite.tenantId,
            clientId: invite.clientId,
            inviteId: invite.id,
          }))
        ) {
          throw new BoundInviteDraftChangedError();
        }
        review = await startFreshGwgReviewTx(tx, {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
        });
      }
      const checkId = review.reviewCheckId;

      const currentClient = await tx.client.findFirst({
        where: { id: invite.clientId, tenantId: invite.tenantId },
        select: {
          kind: true,
          name: true,
          street: true,
          postalCode: true,
          city: true,
          countryIso: true,
          vatId: true,
        },
      });
      if (!currentClient) throw new BoundInviteDraftChangedError();
      // Bei ungebundenen Ersteinladungen kann sich die Rechtsform zwischen
      // Vorvalidierung und Lifecycle-Lock ändern. Dann wären Vertreter- und
      // Nachweispflichten gegen den alten Typ geprüft worden; deshalb
      // fail-closed neu laden statt Daten nach veralteten Regeln zu schreiben.
      if (currentClient.kind !== invite.client.kind) {
        throw new BoundInviteDraftChangedError();
      }

      // Neue Mandanten-/Personenangaben machen jede zuvor gespeicherte
      // Risikobewertung fachlich obsolet. Der Reset liegt in derselben
      // Transaktion und zwingt vor der Berufsträger-Freigabe eine Neubewertung.
      await tx.gwgCheck.update({
        where: { id: checkId },
        data: {
          riskLevel: null,
          riskScore: null,
          riskAnswers: Prisma.DbNull,
          riskBreakdown: Prisma.DbNull,
        },
      });

      // 1. Client-Stammdaten ggf. updaten — und welche Felder geändert wurden
      const before = {
        name: currentClient.name,
        street: currentClient.street,
        postalCode: currentClient.postalCode,
        city: currentClient.city,
        countryIso: currentClient.countryIso,
        vatId: currentClient.vatId,
      };
      const after = {
        name: master.companyName.trim(),
        street: master.street.trim(),
        postalCode: master.postalCode.trim(),
        city: master.city.trim(),
        countryIso: master.countryIso.trim(),
        vatId: master.vatId?.trim() || null,
      };
      const changedFields: string[] = [];
      for (const k of ['name', 'street', 'postalCode', 'city', 'countryIso', 'vatId'] as const) {
        if (before[k] !== after[k]) changedFields.push(k);
      }
      if (changedFields.length > 0) {
        await tx.client.update({ where: { id: invite.clientId }, data: after });
      }

      if (
        parsed.data.legalEntity &&
        (currentClient.kind === 'JURPERS' || currentClient.kind === 'PERSGES')
      ) {
        await tx.gwgCheck.update({
          where: { id: checkId },
          data: { noRegisterEntry: parsed.data.legalEntity.noRegisterEntry },
        });
      }

      // 3. Personenliste dieses bearbeitbaren Snapshots durch die ausdruecklich
      // uebermittelte aktuelle Liste ersetzen. Bereits kopierte/kanzleiseitig
      // hochgeladene Nachweise bleiben am selben Check erhalten; nur alte
      // Personen-Subjects werden durch die FK-Guards sicher geloest.
      const existingOwners = invite.gwgCheckId
        ? await tx.gwgBeneficialOwner.findMany({
            where: { gwgCheckId: checkId },
            select: { id: true, notes: true },
          })
        : [];
      const existingOwnerIds = new Set(existingOwners.map((entry) => entry.id));
      const existingOwnerNotes = new Map(existingOwners.map((entry) => [entry.id, entry.notes]));
      const existingRepresentativeIds = new Set(
        invite.gwgCheckId
          ? (
              await tx.gwgRepresentative.findMany({
                where: { gwgCheckId: checkId },
                select: { id: true },
              })
            ).map((entry) => entry.id)
          : [],
      );
      const existingCheckDocuments = invite.gwgCheckId
        ? await tx.gwgIdDocument.findMany({
            where: { gwgCheckId: checkId },
            select: { id: true, documentId: true, documentSetId: true, type: true },
          })
        : [];
      const existingDocumentById = new Map(
        existingCheckDocuments.flatMap((entry) =>
          entry.documentId ? [[entry.documentId, entry] as const] : [],
        ),
      );
      const replacedRepresentativeCount = await tx.gwgRepresentative.deleteMany({
        where: { gwgCheckId: checkId },
      });
      const replacedOwnerCount = await tx.gwgBeneficialOwner.deleteMany({
        where: { gwgCheckId: checkId },
      });

      const ownerDbIds = new Map(
        owners.map((owner) => [
          owner.localId,
          existingOwnerIds.has(owner.localId) ? owner.localId : randomUUID(),
        ]),
      );
      await tx.gwgBeneficialOwner.createMany({
        data: owners.map((owner) => {
          const snapshot = toBeneficialOwnerSnapshot(owner);
          return {
            id: ownerDbIds.get(owner.localId)!,
            gwgCheckId: checkId,
            ...snapshot,
            notes: existingOwnerNotes.get(owner.localId) ?? snapshot.notes,
          };
        }),
      });

      const representativeDbIds = new Map(
        parsed.data.representatives.map((representative) => [
          representative.localId,
          existingRepresentativeIds.has(representative.localId)
            ? representative.localId
            : randomUUID(),
        ]),
      );
      if (parsed.data.representatives.length > 0) {
        await tx.gwgRepresentative.createMany({
          data: parsed.data.representatives.map((representative, position) => ({
            id: representativeDbIds.get(representative.localId)!,
            gwgCheckId: checkId,
            fullName: representative.linkedOwnerLocalId
              ? owners.find((owner) => owner.localId === representative.linkedOwnerLocalId)!
                  .fullName
              : representative.fullName,
            position,
            linkedBeneficialOwnerId: representative.linkedOwnerLocalId
              ? ownerDbIds.get(representative.linkedOwnerLocalId)!
              : null,
          })),
        });
      }
      await tx.gwgCheck.update({
        where: { id: checkId },
        data: {
          representativeNames: parsed.data.representatives.map((representative) =>
            representative.linkedOwnerLocalId
              ? owners
                  .find((owner) => owner.localId === representative.linkedOwnerLocalId)!
                  .fullName.trim()
              : representative.fullName.trim(),
          ),
        },
      });

      const representativeByOwnerLocalId = new Map(
        parsed.data.representatives.flatMap((representative) =>
          representative.linkedOwnerLocalId
            ? [
                [
                  representative.linkedOwnerLocalId,
                  representativeDbIds.get(representative.localId)!,
                ] as const,
              ]
            : [],
        ),
      );

      async function persistIdentitySet(input: {
        documentIds: [string, string];
        type: 'PERSONALAUSWEIS' | 'REISEPASS';
        ownerName: string;
        number: string | null;
        issuedBy: string | null;
        issueDate: Date | null;
        expiryDate: Date | null;
        beneficialOwnerSubjectId?: string | null;
        representativeSubjectId?: string | null;
        notePrefix?: string;
      }) {
        const existingRows = input.documentIds.flatMap((documentId) => {
          const row = existingDocumentById.get(documentId);
          return row && (row.type === 'PERSONALAUSWEIS' || row.type === 'REISEPASS') ? [row] : [];
        });
        if (new Set(existingRows.map((entry) => entry.documentSetId)).size > 1) {
          throw new BoundInviteDraftChangedError();
        }
        if (existingRows.some((entry) => entry.type !== input.type)) {
          throw new BoundInviteDraftChangedError();
        }
        const documentSetId = existingRows[0]?.documentSetId ?? randomUUID();
        const missingRows = [];
        for (const [side, documentId] of input.documentIds.entries()) {
          const data = {
            gwgCheckId: checkId,
            documentSetId,
            type: input.type,
            ownerName: input.ownerName,
            documentId,
            number: input.number,
            issuedBy: input.issuedBy,
            issueDate: input.issueDate,
            expiryDate: input.expiryDate,
            naturalClientSubjectId: null,
            beneficialOwnerSubjectId: input.beneficialOwnerSubjectId ?? null,
            representativeSubjectId: input.representativeSubjectId ?? null,
            identityAssignmentConfirmedAt: null,
            identityAssignmentConfirmedBy: null,
            verifiedAt: null,
          };
          const notes = input.notePrefix
            ? `${input.notePrefix} – ${side === 0 ? 'Vorderseite' : 'Rückseite'} (durch Mandant hochgeladen)`
            : side === 0
              ? 'Vorderseite (durch Mandant hochgeladen)'
              : 'Rückseite (durch Mandant hochgeladen)';
          const existing = existingDocumentById.get(documentId);
          if (existing && (existing.type === 'PERSONALAUSWEIS' || existing.type === 'REISEPASS')) {
            await tx.gwgIdDocument.updateMany({
              where: { id: existing.id, gwgCheckId: checkId, documentId },
              data,
            });
          } else {
            missingRows.push({ ...data, notes });
          }
        }
        if (missingRows.length > 0) {
          await tx.gwgIdDocument.createMany({ data: missingRows });
        }
      }

      for (const o of owners) {
        const representativeSubjectId = representativeByOwnerLocalId.get(o.localId) ?? null;
        const beneficialOwnerSubjectId = representativeSubjectId
          ? null
          : ownerDbIds.get(o.localId)!;
        await persistIdentitySet({
          documentIds: [o.idFrontDocumentId, o.idBackDocumentId],
          type: o.idType,
          ownerName: o.fullName.trim(),
          number: o.idNumber?.trim() || null,
          issuedBy: o.idIssuedBy?.trim() || null,
          issueDate: o.idIssueDate ? new Date(o.idIssueDate + 'T00:00:00.000Z') : null,
          expiryDate: o.idExpiryDate ? new Date(o.idExpiryDate + 'T00:00:00.000Z') : null,
          beneficialOwnerSubjectId,
          representativeSubjectId,
        });
      }

      for (const representative of parsed.data.representatives) {
        if (representative.linkedOwnerLocalId) continue;
        await persistIdentitySet({
          documentIds: [representative.idFrontDocumentId!, representative.idBackDocumentId!],
          type: representative.idType,
          ownerName: representative.fullName.trim(),
          number: representative.idNumber?.trim() || null,
          issuedBy: representative.idIssuedBy?.trim() || null,
          issueDate: representative.idIssueDate
            ? new Date(representative.idIssueDate + 'T00:00:00.000Z')
            : null,
          expiryDate: representative.idExpiryDate
            ? new Date(representative.idExpiryDate + 'T00:00:00.000Z')
            : null,
          representativeSubjectId: representativeDbIds.get(representative.localId)!,
          notePrefix: 'Vertretung',
        });
      }

      // Rechtsträger-/Zusatznachweise werden typisiert mit dem Check
      // verknüpft. Zuvor blieben diese Uploads lediglich in der Invite-Liste
      // und konnten das fachliche Verify-Gate nie erfüllen.
      for (const evidence of parsed.data.extraDocuments) {
        const existingEvidence = existingDocumentById.get(evidence.documentId);
        const data = {
          gwgCheckId: checkId,
          type: evidence.type,
          ownerName: after.name,
          documentId: evidence.documentId,
        };
        if (existingEvidence) {
          await tx.gwgIdDocument.updateMany({
            where: {
              id: existingEvidence.id,
              gwgCheckId: checkId,
              documentId: evidence.documentId,
            },
            data,
          });
        } else {
          await tx.gwgIdDocument.create({
            data: {
              ...data,
              notes: 'Rechtsträger-/Zusatznachweis (durch Mandant hochgeladen)',
            },
          });
        }
      }
      // 4. Den bereits atomar beanspruchten Invite mit seinem frischen Check
      // verknuepfen. Status/Submit-Nachweise wurden beim Claim gesetzt.
      await tx.gwgOnboardingInvite.update({
        where: { id: invite.id },
        data: {
          gwgCheckId: checkId,
        },
      });

      // 5. Audit-Trail
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: 'gwg.onboarding.submit',
        resourceType: 'gwg_onboarding_invite',
        resourceId: invite.id,
        before,
        after: {
          ...after,
          changedFields,
          ownerCount: owners.length,
          representativeCount: parsed.data.representatives.length,
          linkedRoleCount: linkedOwnerLocalIds.length,
          reusedBoundDraft: Boolean(invite.gwgCheckId),
          replacedOwnerCount: replacedOwnerCount.count,
          replacedRepresentativeCount: replacedRepresentativeCount.count,
          pepCount: owners.filter((owner) => owner.isPep).length,
          noRegisterEntry: parsed.data.legalEntity?.noRegisterEntry ?? null,
          gwgCheckId: checkId,
          supersededInviteCount: claim.supersededInviteCount,
          invalidatedChecks: review.invalidatedChecks,
          clientDeactivated: review.clientDeactivated,
        },
        ip,
        userAgent: ua,
      });
      if (changedFields.length > 0) {
        await evidenceService.record(tx, {
          tenantId: invite.tenantId,
          actorType: 'CLIENT_CONTACT',
          actorId: null,
          action: 'client.update.gwg_relevant',
          resourceType: 'client',
          resourceId: invite.clientId,
          before,
          after: { ...after, _changedFields: changedFields, _via: 'gwg_onboarding' },
          ip,
          userAgent: ua,
        });
      }

      const responsibilities = await tx.clientResponsibility.findMany({
        where: { clientId: invite.clientId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
        select: { staffId: true },
      });
      const staffIds = Array.from(new Set(responsibilities.map((r) => r.staffId)));
      try {
        await notifyMany(tx, staffIds.length > 0 ? staffIds : [null], {
          tenantId: invite.tenantId,
          kind: 'GWG_ONBOARDING_SUBMITTED',
          title: 'GwG-Onboarding eingereicht',
          body: `${after.name} hat GwG-Angaben und Unterlagen übermittelt.`,
          href: `/staff/clients/${invite.clientId}/gwg`,
          resourceType: 'gwg_onboarding_invite',
          resourceId: invite.id,
        });
      } catch (e) {
        log.error(
          {
            component: 'gwg-onboarding-submit',
            inviteId: invite.id,
            tenantId: invite.tenantId,
            clientId: invite.clientId,
            name: (e as Error)?.name,
            err: (e as Error)?.message,
          },
          'GwG onboarding submit notification failed',
        );
      }

      // Finaler, kurzer Display-CAS: Katalog-, Hinweis- und Provider-Änderungen
      // werden erst nach der gesamten GwG-Facharbeit tenantweit serialisiert.
      // Nach dem Lock folgen nur noch Rerender/Hash-Prüfung, unveränderlicher
      // Consent-Snapshot und Audit; jeder Fehler rollt weiterhin die ganze
      // Onboarding-Transaktion atomar zurück.
      await lockConsentCatalogTx(tx, invite.tenantId);
      const notice = await renderNoticeForTenantTx(tx, invite.tenantId);
      if (!notice.complete) {
        throw new Error('PRIVACY_CONFIG_INCOMPLETE');
      }
      const sel = await resolveConsentSelectionsTx(
        tx,
        invite.tenantId,
        parsed.data.consent.selections,
        {
          enforceRequired: true,
          expectedDisplay: {
            revision: parsed.data.consent.displayRevision,
            notice,
          },
        },
      );
      const consentRow = await tx.clientConsent.create({
        data: {
          tenantId: invite.tenantId,
          clientId: invite.clientId,
          noticeVersion: notice.version,
          noticeSnapshot: notice.body,
          consents: sel as object,
          source: 'PORTAL',
          signedByName: parsed.data.consent.signedByName.trim(),
          isRevocation: false,
          note: 'Über GwG-Onboarding-Portal erteilt',
          createdBy: null,
        },
      });
      await evidenceService.record(tx, {
        tenantId: invite.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: null,
        action: 'privacy.consent.grant',
        resourceType: 'client_consent',
        resourceId: consentRow.id,
        after: {
          clientId: invite.clientId,
          noticeVersion: notice.version,
          grantedCount: countGranted(sel),
          signedByName: parsed.data.consent.signedByName.trim(),
          source: 'PORTAL',
          displayRevision: parsed.data.consent.displayRevision,
        },
      });
      return { ok: true } as const;
    });
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

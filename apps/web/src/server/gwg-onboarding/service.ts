// =============================================================================
// GwG-Onboarding-Service
//
// Token-basierter Mandanten-Wizard ohne Portal-Account. Nutzt einen Owner-
// Prisma-Client (BYPASSRLS), weil der Mandant zum Zeitpunkt der Einladung
// keinen Auth-Kontext hat. Tenant- und Client-Zuordnung kommt vom Token.
//
// Sicherheits-Modell:
//   - Token (32 Byte random) wird in plain per Mail an den Mandanten verschickt
//   - Hash (SHA-256) wird in `gwg_onboarding_invite.token_hash` gespeichert
//   - Lookup ausschließlich über den Hash
//   - Ablauf: 14 Tage Default
//   - Submit setzt status='SUBMITTED' und schreibt IP+UserAgent als Audit-Trail
// =============================================================================

import { createHash, randomBytes } from 'node:crypto';
import { fullIdentityViewport, identityViewports } from '@/lib/gwg/identity-viewport';
import { type Client, type GwgIdDocumentType, type Tenant } from '@prisma/client';
import { prismaOwner } from '@/server/db/prisma-owner';
import { revalidateOpenGwgInviteRevisionTx } from './invite-lifecycle';
import {
  GWG_INVITE_DRAFT_INCLUDE,
  type GwgInviteDraftRevisionSource,
} from './invite-draft-revision';

export const INVITE_TTL_DAYS = 14;

export function generateInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function hashInviteToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Markiert eine Einladung nur dann als abgelaufen, wenn sie beim Write noch
 * offen und zum selben Lookup-Zeitpunkt faellig ist. Der statusgebundene CAS
 * verhindert, dass ein wartender Ablauf-Write einen parallel bereits
 * geclaimten SUBMITTED- oder CANCELLED-Status ueberschreibt.
 */
export async function expireOpenInviteIfDue(inviteId: string, now: Date): Promise<boolean> {
  const expired = await prismaOwner.gwgOnboardingInvite.updateMany({
    where: {
      id: inviteId,
      status: { in: ['PENDING', 'STARTED'] },
      expiresAt: { lte: now },
    },
    data: { status: 'EXPIRED' },
  });
  return expired.count === 1;
}

export interface LoadedInvite {
  inviteId: string;
  inviteName: string;
  inviteEmail: string;
  status: 'PENDING' | 'STARTED' | 'SUBMITTED' | 'EXPIRED' | 'CANCELLED';
  expiresAt: Date;
  client: Pick<Client, 'id' | 'name' | 'kind' | 'street' | 'postalCode' | 'city' | 'countryIso'>;
  tenant: Pick<Tenant, 'id' | 'name' | 'slug'>;
  draft: LoadedInviteDraft | null;
}

interface LoadedInviteFile {
  documentId: string;
  fileName: string;
  versionId?: string;
  viewport?: import('@/lib/gwg/identity-viewport').IdentityViewport;
}

export interface LoadedInviteDraftOwner {
  id: string;
  fullName: string;
  birthDate: string;
  birthPlace: string;
  nationality: string;
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
  sharePercent: string;
  isPep: boolean;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: LoadedInviteFile | null;
  idBack: LoadedInviteFile | null;
}

export interface LoadedInviteDraftRepresentative {
  id: string;
  fullName: string;
  linkedOwnerId: string | null;
  idType: 'PERSONALAUSWEIS' | 'REISEPASS';
  idNumber: string;
  idIssuedBy: string;
  idIssueDate: string;
  idExpiryDate: string;
  idFront: LoadedInviteFile | null;
  idBack: LoadedInviteFile | null;
}

export interface LoadedInviteDraft {
  checkId: string;
  noRegisterEntry: boolean | null;
  owners: LoadedInviteDraftOwner[];
  representatives: LoadedInviteDraftRepresentative[];
  extraDocuments: Array<
    LoadedInviteFile & {
      type:
        | 'HANDELSREGISTERAUSZUG'
        | 'GESELLSCHAFTSVERTRAG'
        | 'TRANSPARENZREGISTER_AUSZUG'
        | 'VOLLMACHT'
        | 'SONSTIGES';
    }
  >;
}

function dateOnly(value: Date | null): string {
  return value?.toISOString().slice(0, 10) ?? '';
}

function splitResidence(value: string | null): {
  street: string;
  postalCode: string;
  city: string;
  countryIso: string;
} {
  const parts = (value ?? '').split(',').map((part) => part.trim());
  const postalCity = parts[1] ?? '';
  const match = postalCity.match(/^(\S+)\s+(.+)$/);
  return {
    street: parts[0] ?? '',
    postalCode: match?.[1] ?? '',
    city: match?.[2] ?? postalCity,
    countryIso: parts[2] || 'DE',
  };
}

interface SubjectIdentityDocument {
  id: string;
  type: GwgIdDocumentType;
  documentId: string | null;
  documentSetId: string;
  notes: string | null;
  viewports?: unknown;
  number: string | null;
  issuedBy: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  beneficialOwnerSubjectId: string | null;
  representativeSubjectId: string | null;
  document: {
    id: string;
    title: string;
    versions: Array<{
      id: string;
      scanStatus: string;
      scanCompletedAt: Date | null;
      storageVersionId: string | null;
    }>;
  } | null;
}

function loadedIdentityFile(
  entry: SubjectIdentityDocument | undefined,
  side: 'front' | 'back',
): LoadedInviteFile | null {
  if (!entry?.documentId || !entry.document) return null;
  const version = entry.document.versions[0];
  if (
    !version ||
    version.scanStatus !== 'CLEAN' ||
    !version.scanCompletedAt ||
    !version.storageVersionId
  )
    return null;
  const stored = identityViewports(entry.viewports);
  if (
    entry.viewports != null &&
    (!Array.isArray(entry.viewports) || entry.viewports.length !== stored.length)
  )
    return null;
  const saved = stored.find((view) => view.side === side);
  if ((stored.length && !saved) || (saved && saved.versionId !== version.id)) return null;
  // Legacy distinct originals get a source binding without requiring OCR.
  const viewport = saved ?? fullIdentityViewport(version.id, side);
  return {
    documentId: entry.documentId,
    fileName: entry.document.title,
    versionId: version.id,
    viewport,
  };
}

function filesForSubject(
  documents: SubjectIdentityDocument[],
  subject: { ownerId?: string; representativeId?: string },
) {
  const assigned = documents
    .filter(
      (entry) =>
        (subject.ownerId && entry.beneficialOwnerSubjectId === subject.ownerId) ||
        (subject.representativeId && entry.representativeSubjectId === subject.representativeId),
    )
    .filter((entry) => entry.type === 'PERSONALAUSWEIS' || entry.type === 'REISEPASS')
    .sort((left, right) => left.id.localeCompare(right.id));
  const documentSetIds = new Set(assigned.map((entry) => entry.documentSetId));
  if (documentSetIds.size > 1) {
    throw new Error('GWG_BOUND_DRAFT_MULTIPLE_IDENTITY_SETS');
  }
  if (assigned.length > 2) {
    throw new Error('GWG_BOUND_DRAFT_IDENTITY_SET_TOO_LARGE');
  }
  if (new Set(assigned.map((entry) => entry.type)).size > 1) {
    throw new Error('GWG_BOUND_DRAFT_MIXED_IDENTITY_TYPES');
  }
  const explicitFront =
    assigned.find((entry) =>
      identityViewports(entry.viewports).some((view) => view.side === 'front'),
    ) ?? assigned.find((entry) => entry.notes?.toLowerCase().includes('vorder'));
  const explicitBack =
    assigned.find((entry) =>
      identityViewports(entry.viewports).some((view) => view.side === 'back'),
    ) ?? assigned.find((entry) => entry.notes?.toLowerCase().includes('rück'));
  const front = explicitFront ?? assigned.find((entry) => entry.id !== explicitBack?.id);
  const back = explicitBack ?? assigned.find((entry) => entry.id !== front?.id);
  const details = assigned[0];
  const idType: 'PERSONALAUSWEIS' | 'REISEPASS' =
    assigned[0]?.type === 'REISEPASS' ? 'REISEPASS' : 'PERSONALAUSWEIS';
  return {
    idType,
    idNumber: details?.number ?? '',
    idIssuedBy: details?.issuedBy ?? '',
    idIssueDate: dateOnly(details?.issueDate ?? null),
    idExpiryDate: dateOnly(details?.expiryDate ?? null),
    idFront: loadedIdentityFile(front, 'front'),
    idBack: loadedIdentityFile(back, 'back'),
  };
}

function loadedDraft(draft: GwgInviteDraftRevisionSource): LoadedInviteDraft {
  const representatives = draft.representatives as Array<
    (typeof draft.representatives)[number] & { linkedBeneficialOwnerId: string | null }
  >;
  const documents = draft.idDocuments as Parameters<typeof filesForSubject>[0];
  return {
    checkId: draft.id,
    noRegisterEntry: draft.noRegisterEntry,
    owners: draft.beneficialOwners.map((owner) => {
      const linkedRepresentative = representatives.find(
        (representative) => representative.linkedBeneficialOwnerId === owner.id,
      );
      const residence = splitResidence(owner.residence);
      return {
        id: owner.id,
        fullName: owner.fullName,
        birthDate: dateOnly(owner.birthDate),
        birthPlace: owner.birthPlace ?? '',
        nationality: owner.nationality ?? '',
        ...residence,
        sharePercent:
          owner.ownershipPct?.toString() ?? owner.notes?.replace(/^Anteil:\s*/, '') ?? '',
        isPep: owner.isPep,
        ...filesForSubject(
          documents,
          linkedRepresentative
            ? { ownerId: owner.id, representativeId: linkedRepresentative.id }
            : { ownerId: owner.id },
        ),
      };
    }),
    representatives: representatives.map((representative) => ({
      id: representative.id,
      fullName: representative.fullName,
      linkedOwnerId: representative.linkedBeneficialOwnerId,
      ...(representative.linkedBeneficialOwnerId
        ? {
            idType: 'PERSONALAUSWEIS' as const,
            idNumber: '',
            idIssuedBy: '',
            idIssueDate: '',
            idExpiryDate: '',
            idFront: null,
            idBack: null,
          }
        : filesForSubject(documents, { representativeId: representative.id })),
    })),
    extraDocuments: documents.flatMap((entry) => {
      if (
        entry.type === 'PERSONALAUSWEIS' ||
        entry.type === 'REISEPASS' ||
        !entry.documentId ||
        !entry.document
      ) {
        return [];
      }
      return [{ documentId: entry.documentId, fileName: entry.document.title, type: entry.type }];
    }),
  };
}

// S-5: Einheitliche Fehlermeldung für alle „Token nicht nutzbar"-Zustände
// (nicht gefunden / cancelled / submitted / expired). Vorher konnten vier
// unterscheidbare Texte den Token-Lifecycle gegenüber einem Angreifer mit
// abgegriffenem Token (Mail-Log, Browser-History) leaken. Symmetrisch zum
// PoA-GENERIC_TOKEN_ERROR-Pattern. Exportiert, damit auch der Rate-Limit-
// Pfad der Page dieselbe Ansicht rendert (kein Token-Probing-Orakel).
export const GENERIC_TOKEN_ERROR = 'Einladung ungültig oder nicht mehr verfügbar.';

export async function loadInviteByRawToken(
  rawToken: string,
): Promise<{ ok: true; invite: LoadedInvite } | { ok: false; error: string }> {
  if (!rawToken || rawToken.length < 10) {
    return { ok: false, error: GENERIC_TOKEN_ERROR };
  }
  const tokenHash = hashInviteToken(rawToken);
  return prismaOwner.$transaction(async (tx) => {
    const candidate = await tx.gwgOnboardingInvite.findFirst({
      where: { tokenHash },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        status: true,
        expiresAt: true,
      },
    });
    if (
      !candidate ||
      candidate.status === 'CANCELLED' ||
      candidate.status === 'SUBMITTED' ||
      candidate.status === 'EXPIRED'
    ) {
      return { ok: false as const, error: GENERIC_TOKEN_ERROR };
    }
    const now = new Date();
    if (candidate.expiresAt.getTime() <= now.getTime()) {
      await tx.gwgOnboardingInvite.updateMany({
        where: {
          id: candidate.id,
          tokenHash,
          status: { in: ['PENDING', 'STARTED'] },
          expiresAt: { lte: now },
        },
        data: { status: 'EXPIRED' },
      });
      return { ok: false as const, error: GENERIC_TOKEN_ERROR };
    }

    const revisionCurrent = await revalidateOpenGwgInviteRevisionTx(tx, {
      inviteId: candidate.id,
      tenantId: candidate.tenantId,
      clientId: candidate.clientId,
      tokenHash,
      now,
    });
    if (!revisionCurrent) {
      return { ok: false as const, error: GENERIC_TOKEN_ERROR };
    }

    const inv = await tx.gwgOnboardingInvite.findFirst({
      where: {
        id: candidate.id,
        tokenHash,
        status: { in: ['PENDING', 'STARTED'] },
        expiresAt: { gt: now },
      },
      include: {
        client: {
          select: {
            id: true,
            name: true,
            kind: true,
            street: true,
            postalCode: true,
            city: true,
            countryIso: true,
          },
        },
        tenant: { select: { id: true, name: true, slug: true } },
        gwgCheck: { include: GWG_INVITE_DRAFT_INCLUDE },
      },
    });
    if (!inv) {
      return { ok: false as const, error: GENERIC_TOKEN_ERROR };
    }

    let draft: LoadedInviteDraft | null;
    try {
      draft = inv.gwgCheck ? loadedDraft(inv.gwgCheck) : null;
    } catch {
      // Der Zwei-Seiten-Wizard darf mehrere getrennte Ausweissätze niemals
      // heuristisch mischen oder beim Submit implizit entfernen.
      return { ok: false as const, error: GENERIC_TOKEN_ERROR };
    }

    let effectiveStatus = inv.status;
    if (inv.status === 'PENDING') {
      const started = await tx.gwgOnboardingInvite.updateMany({
        where: {
          id: inv.id,
          tokenHash,
          status: 'PENDING',
          expiresAt: { gt: now },
        },
        data: { status: 'STARTED' },
      });
      if (started.count !== 1) {
        return { ok: false, error: GENERIC_TOKEN_ERROR };
      }
      effectiveStatus = 'STARTED';
    }

    return {
      ok: true as const,
      invite: {
        inviteId: inv.id,
        inviteName: inv.inviteName,
        inviteEmail: inv.inviteEmail,
        status: effectiveStatus,
        expiresAt: inv.expiresAt,
        client: inv.client,
        tenant: inv.tenant,
        draft,
      },
    };
  });
}

export { prismaOwner };

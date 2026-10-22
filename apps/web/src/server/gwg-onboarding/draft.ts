// =============================================================================
// GWG-SELF-ONBOARDING-001: Zwischenstand der Online-Einreichung je Einladung.
//
// Der Wizard speichert seinen Formularstand laufend, damit der Mandant neu
// laden oder auf einem anderen Gerät weitermachen kann. Gespeichert werden nur
// Angaben und Verweise auf bereits hochgeladene Dateien dieser Einladung. Beim
// Laden zählen nur Verweise auf finalisierte Uploads der Einladung oder auf
// Belege der gebundenen Prüfung; alles andere wird verworfen. Die Revision
// verhindert, dass zwei Geräte sich still überschreiben.
// =============================================================================

import { z } from 'zod';
import type { TxClient } from '@taxtronik/db';
import { IDENTITY_FIELD_LABELS, type IdentityField } from '@/lib/gwg/identity-ocr';
import { IdentityViewportSchema } from '@/lib/gwg/identity-viewport';

const text = (max: number) => z.string().max(max);
const IDENTITY_FIELDS = Object.keys(IDENTITY_FIELD_LABELS) as [IdentityField, ...IdentityField[]];

const DraftFileSchema = z
  .object({
    documentId: z.string().uuid(),
    fileName: text(255),
    versionId: z.string().uuid().optional(),
    viewport: IdentityViewportSchema.optional(),
  })
  .nullable();

const DraftOwnerSchema = z.object({
  id: text(100),
  fullName: text(200),
  birthDate: text(10),
  birthPlace: text(200),
  nationality: text(50),
  street: text(255),
  postalCode: text(20),
  city: text(100),
  countryIso: text(10),
  sharePercent: text(50),
  isPep: z.boolean().nullable(),
  idType: z.enum(['PERSONALAUSWEIS', 'REISEPASS']),
  idNumber: text(100),
  idIssuedBy: text(200),
  idIssueDate: text(10),
  idExpiryDate: text(10),
  idFront: DraftFileSchema,
  idBack: DraftFileSchema,
  identityApplied: z.array(z.enum(IDENTITY_FIELDS)).max(30).optional(),
});

const DraftRepresentativeSchema = z.object({
  id: text(100),
  fullName: text(200),
  linkedOwnerId: text(100).nullable().optional(),
  idType: z.enum(['PERSONALAUSWEIS', 'REISEPASS']),
  idNumber: text(100),
  idIssuedBy: text(200),
  idIssueDate: text(10),
  idExpiryDate: text(10),
  idFront: DraftFileSchema,
  idBack: DraftFileSchema,
  identityApplied: z.array(z.enum(IDENTITY_FIELDS)).max(30).optional(),
});

export const OnboardingDraftPayloadSchema = z.object({
  version: z.literal(1),
  step: z.number().int().min(0).max(4),
  reached: z.number().int().min(0).max(4),
  master: z.object({
    companyName: text(200),
    street: text(255),
    postalCode: text(20),
    city: text(100),
    countryIso: text(10),
  }),
  owners: z.array(DraftOwnerSchema).max(50),
  representatives: z.array(DraftRepresentativeSchema).max(50),
  extraDocuments: z
    .array(
      z.object({
        documentId: z.string().uuid(),
        fileName: text(255),
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
  noRegisterEntry: z.boolean().nullable(),
});

export type OnboardingDraftPayload = z.infer<typeof OnboardingDraftPayloadSchema>;

export interface LoadedOnboardingDraft {
  revision: number;
  updatedAt: string;
  payload: OnboardingDraftPayload;
}

/** Verweise nur auf Dateien behalten, die zu dieser Einladung bzw. Prüfung gehören. */
export function sanitizeDraftDocuments(
  payload: OnboardingDraftPayload,
  allowedDocumentIds: ReadonlySet<string>,
): OnboardingDraftPayload {
  const file = <T extends { documentId: string } | null>(entry: T): T | null =>
    entry && allowedDocumentIds.has(entry.documentId) ? entry : null;
  return {
    ...payload,
    owners: payload.owners.map((owner) => ({
      ...owner,
      idFront: file(owner.idFront),
      idBack: file(owner.idBack),
    })),
    representatives: payload.representatives.map((representative) => ({
      ...representative,
      idFront: file(representative.idFront),
      idBack: file(representative.idBack),
    })),
    extraDocuments: payload.extraDocuments.filter((document) =>
      allowedDocumentIds.has(document.documentId),
    ),
  };
}

/** Dokument-IDs, die der gebundene Prüfentwurf bereits enthält. */
export function draftDocumentIds(
  draft: {
    owners: ReadonlyArray<{
      idFront: { documentId: string } | null;
      idBack: { documentId: string } | null;
    }>;
    representatives: ReadonlyArray<{
      idFront: { documentId: string } | null;
      idBack: { documentId: string } | null;
    }>;
    extraDocuments: ReadonlyArray<{ documentId: string }>;
  } | null,
): string[] {
  if (!draft) return [];
  return [
    ...[...draft.owners, ...draft.representatives].flatMap((person) =>
      [person.idFront?.documentId, person.idBack?.documentId].filter((id): id is string =>
        Boolean(id),
      ),
    ),
    ...draft.extraDocuments.map((document) => document.documentId),
  ];
}

/** Zwischenstand einer offenen Einladung; ungültige oder fremde Inhalte zählen nicht. */
export async function loadOnboardingDraftTx(
  tx: TxClient,
  input: { inviteId: string; allowedDocumentIds: ReadonlySet<string> },
): Promise<LoadedOnboardingDraft | null> {
  const row = await tx.gwgOnboardingDraft.findUnique({ where: { inviteId: input.inviteId } });
  if (!row) return null;
  const parsed = OnboardingDraftPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return {
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
    payload: sanitizeDraftDocuments(parsed.data, input.allowedDocumentIds),
  };
}

export type SaveOnboardingDraftResult =
  | { ok: true; revision: number; updatedAt: string }
  | { ok: false; conflict: true; revision: number };

/**
 * Speichert nur, wenn der Stand auf der zuletzt gelesenen Revision aufbaut
 * (0 = noch kein Zwischenstand). Sonst hat ein anderes Gerät inzwischen
 * gespeichert; der Wizard bietet dann das Neuladen an.
 */
export async function saveOnboardingDraftTx(
  tx: TxClient,
  input: {
    inviteId: string;
    tenantId: string;
    expectedRevision: number;
    payload: OnboardingDraftPayload;
  },
): Promise<SaveOnboardingDraftResult> {
  const now = new Date();
  if (input.expectedRevision === 0) {
    const created = await tx.gwgOnboardingDraft.createMany({
      data: [
        {
          inviteId: input.inviteId,
          tenantId: input.tenantId,
          payload: input.payload,
          revision: 1,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 1) return { ok: true, revision: 1, updatedAt: now.toISOString() };
  } else {
    const updated = await tx.gwgOnboardingDraft.updateMany({
      where: { inviteId: input.inviteId, revision: input.expectedRevision },
      data: { payload: input.payload, revision: { increment: 1 }, updatedAt: now },
    });
    if (updated.count === 1)
      return { ok: true, revision: input.expectedRevision + 1, updatedAt: now.toISOString() };
  }
  const current = await tx.gwgOnboardingDraft.findUnique({
    where: { inviteId: input.inviteId },
    select: { revision: true },
  });
  return { ok: false, conflict: true, revision: current?.revision ?? 0 };
}

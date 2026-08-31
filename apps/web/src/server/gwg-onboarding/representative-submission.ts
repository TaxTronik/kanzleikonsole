import { z } from 'zod';
import { IdentityViewportSchema, distinctIdentityViews } from '@/lib/gwg/identity-viewport';
import { validateIdentityDates } from '@/server/gwg/identity-date-validation';

export const GwgOnboardingLocalPersonIdSchema = z.string().min(1).max(100);

export const GwgOnboardingRepresentativeSchema = z
  .object({
    localId: GwgOnboardingLocalPersonIdSchema,
    fullName: z.string().trim().min(1).max(200),
    linkedOwnerLocalId: GwgOnboardingLocalPersonIdSchema.nullable(),
    idType: z.enum(['PERSONALAUSWEIS', 'REISEPASS']).default('PERSONALAUSWEIS'),
    idNumber: z.string().trim().max(100).optional().or(z.literal('')),
    idIssuedBy: z.string().trim().max(200).optional().or(z.literal('')),
    idIssueDate: z.string().date().optional().or(z.literal('')),
    idExpiryDate: z.string().date().optional().or(z.literal('')),
    idFrontDocumentId: z.string().uuid().nullable(),
    idBackDocumentId: z.string().uuid().nullable(),
    idFrontViewport: IdentityViewportSchema.optional(),
    idBackViewport: IdentityViewportSchema.optional(),
  })
  .superRefine((representative, ctx) => {
    if (representative.linkedOwnerLocalId) return;
    if (
      (representative.idFrontViewport && representative.idFrontViewport.side !== 'front') ||
      (representative.idBackViewport && representative.idBackViewport.side !== 'back') ||
      (representative.idFrontDocumentId &&
        representative.idFrontDocumentId === representative.idBackDocumentId &&
        !distinctIdentityViews(representative.idFrontViewport, representative.idBackViewport))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['idBackViewport'],
        message: 'Bitte zwei unterschiedliche Ausweisseiten mit gültigem Quellbezug auswählen.',
      });
    }
    for (const [field, label] of [
      ['idNumber', 'Ausweisnummer'],
      ['idIssuedBy', 'ausstellende Behörde'],
      ['idIssueDate', 'Ausstellungsdatum'],
      ['idExpiryDate', 'Gültigkeitsdatum'],
      ['idFrontDocumentId', 'Ausweis-Vorderseite'],
      ['idBackDocumentId', 'Ausweis-Rückseite'],
      ['idFrontViewport', 'Quellversion der Ausweis-Vorderseite'],
      ['idBackViewport', 'Quellversion der Ausweis-Rückseite'],
    ] as const) {
      if (!representative[field]) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${label} der vertretungsberechtigten Person ist Pflicht.`,
        });
      }
    }
    for (const issue of validateIdentityDates({
      issueDate: representative.idIssueDate,
      expiryDate: representative.idExpiryDate,
    })) {
      ctx.addIssue({
        code: 'custom',
        path: [issue.field === 'expiryDate' ? 'idExpiryDate' : 'idIssueDate'],
        message: issue.message,
      });
    }
  });

export type GwgOnboardingRepresentativeInput = z.infer<typeof GwgOnboardingRepresentativeSchema>;

export function onboardingRepresentativeRoleError(
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES',
  ownerLocalIds: ReadonlySet<string>,
  representatives: GwgOnboardingRepresentativeInput[],
): string | null {
  if (clientKind === 'NATPERS' && representatives.length > 0) {
    return 'Für natürliche Personen ist keine gesetzliche Vertretung vorgesehen.';
  }
  if (clientKind !== 'NATPERS' && representatives.length === 0) {
    return 'Mindestens eine vertretungsberechtigte Person ist Pflicht.';
  }

  const representativeIds = new Set(
    representatives.map((representative) => representative.localId),
  );
  if (representativeIds.size !== representatives.length) {
    return 'Gesetzliche Vertretungen enthalten doppelte Personen-IDs.';
  }
  const linkedOwnerIds = representatives.flatMap((representative) =>
    representative.linkedOwnerLocalId ? [representative.linkedOwnerLocalId] : [],
  );
  if (linkedOwnerIds.some((ownerId) => !ownerLocalIds.has(ownerId))) {
    return 'Eine Doppelrolle verweist nicht auf einen übermittelten wirtschaftlich Berechtigten.';
  }
  if (new Set(linkedOwnerIds).size !== linkedOwnerIds.length) {
    return 'Ein wirtschaftlich Berechtigter darf nur einmal als dieselbe Vertretung verknüpft werden.';
  }
  return null;
}

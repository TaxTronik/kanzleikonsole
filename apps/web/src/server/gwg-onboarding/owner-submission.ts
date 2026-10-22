import { z } from 'zod';
import { IdentityViewportSchema, distinctIdentityViews } from '@/lib/gwg/identity-viewport';
import { validateIdentityDates } from '@/server/gwg/identity-date-validation';
import { IDENTITY_FIELD_LABELS, type IdentityField } from '@/lib/gwg/identity-ocr';

/**
 * GWG-OCR-ASSIST-001: Felder, die der Mandant aus der lokalen Ausweishilfe
 * übernommen und danach nicht selbst geändert hat. Nur Feldnamen; dient der
 * Kanzlei als Herkunftsangabe, nicht als Prüfnachweis.
 */
export const IdentityAssistedFieldsSchema = z
  .array(z.enum(Object.keys(IDENTITY_FIELD_LABELS) as [IdentityField, ...IdentityField[]]))
  .max(Object.keys(IDENTITY_FIELD_LABELS).length * 2)
  .default([])
  .transform((fields) => [...new Set(fields)]);

/**
 * Serverseitiger Vertrag fuer eine im oeffentlichen GwG-Onboarding erfasste
 * Person. Der PEP-Status hat bewusst keinen Default: Ja oder Nein muss explizit
 * uebermittelt werden.
 */
export const GwgOnboardingOwnerSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    birthDate: z.string().date(),
    birthPlace: z.string().trim().min(1, 'Geburtsort ist Pflicht.').max(200),
    nationality: z.string().trim().min(1, 'Staatsangehoerigkeit ist Pflicht.').max(50),
    street: z.string().trim().min(1, 'Wohnanschrift (Strasse) ist Pflicht.').max(255),
    postalCode: z.string().trim().min(1, 'Wohnanschrift (PLZ) ist Pflicht.').max(20),
    city: z.string().trim().min(1, 'Wohnanschrift (Ort) ist Pflicht.').max(100),
    countryIso: z.string().trim().min(1, 'Land ist Pflicht.').max(10),
    sharePercent: z.string().trim().min(1, 'Anteil ist Pflicht.').max(50),
    isPep: z.boolean(),
    idType: z.enum(['PERSONALAUSWEIS', 'REISEPASS']).default('PERSONALAUSWEIS'),
    idNumber: z.string().trim().min(1, 'Ausweisnummer ist Pflicht.').max(100),
    idIssuedBy: z.string().trim().min(1, 'Ausstellende Behoerde ist Pflicht.').max(200),
    idIssueDate: z.string().date(),
    idExpiryDate: z.string().date(),
    idFrontDocumentId: z.string().uuid(),
    idBackDocumentId: z.string().uuid(),
    idFrontViewport: IdentityViewportSchema,
    idBackViewport: IdentityViewportSchema,
    identityAssistedFields: IdentityAssistedFieldsSchema,
  })
  .superRefine((owner, ctx) => {
    if (
      (owner.idFrontViewport && owner.idFrontViewport.side !== 'front') ||
      (owner.idBackViewport && owner.idBackViewport.side !== 'back') ||
      (owner.idFrontDocumentId === owner.idBackDocumentId &&
        !distinctIdentityViews(owner.idFrontViewport, owner.idBackViewport))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['idBackViewport'],
        message: 'Bitte zwei unterschiedliche Ausweisseiten mit gültigem Quellbezug auswählen.',
      });
    }
    for (const issue of validateIdentityDates({
      birthDate: owner.birthDate,
      issueDate: owner.idIssueDate,
      expiryDate: owner.idExpiryDate,
    })) {
      ctx.addIssue({
        code: 'custom',
        path: [
          issue.field === 'issueDate'
            ? 'idIssueDate'
            : issue.field === 'expiryDate'
              ? 'idExpiryDate'
              : 'birthDate',
        ],
        message: issue.message,
      });
    }
  });

export type GwgOnboardingOwnerInput = z.infer<typeof GwgOnboardingOwnerSchema>;

/** Kanonische Felder fuer den gespeicherten Berechtigten-Snapshot. */
export function toBeneficialOwnerSnapshot(owner: GwgOnboardingOwnerInput) {
  const residenceParts = [
    owner.street.trim(),
    [owner.postalCode.trim(), owner.city.trim()].filter(Boolean).join(' '),
    owner.countryIso?.trim(),
  ].filter(Boolean);
  const shareMatch = (owner.sharePercent ?? '').match(/(\d+(?:[.,]\d+)?)/);
  const parsedOwnershipPct = shareMatch ? Number(shareMatch[1]!.replace(',', '.')) : null;
  const ownershipPct =
    parsedOwnershipPct !== null && parsedOwnershipPct >= 0 && parsedOwnershipPct <= 100
      ? parsedOwnershipPct
      : null;
  const notes =
    owner.sharePercent && ownershipPct === null ? `Anteil: ${owner.sharePercent.trim()}` : null;

  return {
    fullName: owner.fullName.trim(),
    birthDate: new Date(`${owner.birthDate}T00:00:00.000Z`),
    birthPlace: owner.birthPlace.trim(),
    nationality: owner.nationality.trim(),
    residence: residenceParts.join(', '),
    ownershipPct,
    isPep: owner.isPep,
    notes,
    identityAssistedFields: owner.identityAssistedFields,
  };
}

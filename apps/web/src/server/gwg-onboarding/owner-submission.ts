import { z } from 'zod';

/**
 * Serverseitiger Vertrag fuer eine im oeffentlichen GwG-Onboarding erfasste
 * Person. Der PEP-Status hat bewusst keinen Default: Ja oder Nein muss explizit
 * uebermittelt werden.
 */
export const GwgOnboardingOwnerSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  birthDate: z.string().date(),
  birthPlace: z.string().trim().min(1, 'Geburtsort ist Pflicht.').max(200),
  nationality: z.string().trim().min(1, 'Staatsangehoerigkeit ist Pflicht.').max(50),
  street: z.string().trim().min(1, 'Wohnanschrift (Strasse) ist Pflicht.').max(255),
  postalCode: z.string().trim().min(1, 'Wohnanschrift (PLZ) ist Pflicht.').max(20),
  city: z.string().trim().min(1, 'Wohnanschrift (Ort) ist Pflicht.').max(100),
  countryIso: z.string().trim().max(10).optional().or(z.literal('')),
  sharePercent: z.string().trim().max(50).optional().or(z.literal('')),
  isPep: z.boolean(),
  idNumber: z.string().trim().min(1, 'Ausweisnummer ist Pflicht.').max(100),
  idIssuedBy: z.string().trim().min(1, 'Ausstellende Behoerde ist Pflicht.').max(200),
  idIssueDate: z.string().date().optional().or(z.literal('')),
  idExpiryDate: z.string().date(),
  idFrontDocumentId: z.string().uuid(),
  idBackDocumentId: z.string().uuid(),
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
  };
}

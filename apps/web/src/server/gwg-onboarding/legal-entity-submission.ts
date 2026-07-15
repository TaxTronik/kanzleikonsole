import { z } from 'zod';

export const GwgOnboardingLegalEntityDeclarationSchema = z
  .object({
    /** Erklaerung: kein Registereintrag / keine Registerpflicht (z. B. einfache GbR). */
    noRegisterEntry: z.boolean(),
  })
  .nullable();

export type GwgOnboardingLegalEntityDeclaration = z.infer<
  typeof GwgOnboardingLegalEntityDeclarationSchema
>;

/**
 * Fachliches Gate fuer Rechtstraeger-Nachweise im Self-Service. Eine nicht
 * registerpflichtige Gesellschaft braucht einen Gesellschaftsvertrag und die
 * ausdrueckliche Erklaerung, aber keinen nicht existierenden Transparenzregister-
 * Auszug. Im normalen Registerfall bleibt der Auszug zwingend.
 */
export function legalEntityEvidenceError(
  clientKind: 'NATPERS' | 'JURPERS' | 'PERSGES',
  declaration: GwgOnboardingLegalEntityDeclaration,
  evidenceTypes: ReadonlySet<string>,
): string | null {
  if (clientKind === 'NATPERS') {
    return declaration === null
      ? null
      : 'Eine Registererklärung ist nur für einen Rechtsträger zulässig.';
  }
  if (!declaration) {
    return 'Bitte erklären Sie, ob ein Registereintrag vorhanden ist.';
  }

  if (declaration.noRegisterEntry) {
    if (!evidenceTypes.has('GESELLSCHAFTSVERTRAG')) {
      return 'Bei einer nicht registerpflichtigen Gesellschaft ist ein Gesellschaftsvertrag oder gleichwertiger Gründungsnachweis erforderlich.';
    }
    return null;
  }

  if (!evidenceTypes.has('HANDELSREGISTERAUSZUG') && !evidenceTypes.has('GESELLSCHAFTSVERTRAG')) {
    return 'Registerauszug oder Gründungsnachweis ist für den Rechtsträger erforderlich.';
  }
  if (!evidenceTypes.has('TRANSPARENZREGISTER_AUSZUG')) {
    return 'Ein Transparenzregister-Auszug ist für den eingetragenen Rechtsträger erforderlich.';
  }
  return null;
}

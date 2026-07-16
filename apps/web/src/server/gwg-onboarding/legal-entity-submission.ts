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
 * Auszug.
 *
 * Der Transparenzregister-Auszug ist im Self-Service bewusst KEIN Pflichtfeld:
 * der Abruf ist fuer den Mandanten kostenpflichtig — die Kanzlei ruft ihn im
 * Rahmen der GwG-Pruefung selbst ab. Ein freiwilliger Upload bleibt moeglich
 * (Dokumenttyp existiert weiter in der Auswahl).
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
  return null;
}

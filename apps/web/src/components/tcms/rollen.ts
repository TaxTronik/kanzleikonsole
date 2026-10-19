// =============================================================================
// Rollen der Mandantenseite im Tax-CMS (TCMS Stufe 3; ADR 0001 §5 im TCMS-Repo:
// MandantKontaktRolle). Werte wie im Vertrag (vertrag-und-tokens.test.ts
// gleicht sie mit KontaktRollenBodySchema ab); die Domain führt dafür keine
// Labels.
// =============================================================================

export const TCMS_KONTAKT_ROLLEN = [
  'GESETZLICHER_VERTRETER',
  'TAX_COMPLIANCE_BEAUFTRAGTER',
  'MITARBEITER',
] as const;

export type TcmsKontaktRolle = (typeof TCMS_KONTAKT_ROLLEN)[number];

/** Typwächter für Formularwerte (Fehler am Feld `rollen`, nicht an einem Index). */
export function istKontaktRolle(wert: string): wert is TcmsKontaktRolle {
  return (TCMS_KONTAKT_ROLLEN as readonly string[]).includes(wert);
}

export const TCMS_KONTAKT_ROLLE_LABEL: Readonly<Record<TcmsKontaktRolle, string>> = {
  GESETZLICHER_VERTRETER: 'Gesetzliche Vertretung',
  TAX_COMPLIANCE_BEAUFTRAGTER: 'Tax-Compliance-Beauftragte',
  MITARBEITER: 'Mitarbeitende',
};

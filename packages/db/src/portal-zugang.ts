// =============================================================================
// Aktiver Portalzugang eines Mandantenkontakts (TCMS-AKTEUR-001, MAIL-OUTBOX-001;
// kk-tcms-s11 Punkt 4, Produktentscheidung Rey Koxha, 21.10.2026).
//
// Eine Freigabe, Risikoakzeptanz oder Kenntnisnahme im Tax-CMS gibt der
// Kontakt im Mandantenportal mit einem Bestätigungscode per E-Mail ab. Die
// kanzleikonsole adressiert solche Anforderungen deshalb nur an Kontakte, die
// das Portal tatsächlich nutzen können und deren Adresse bestätigt ist – mit
// derselben Regel, mit der der Zustell-Worker die Mitteilung zustellt (sonst
// stellt er sie als „kein bestätigter Portalzugang“ zurück):
//   - der Kontakt ist aktiv und gehört genau zu diesem Mandanten,
//   - der Mandant ist für das Portal zugelassen (allowActive), nicht
//     anonymisiert und sein Mandat nicht beendet (wie die Portal-Anmeldung),
//   - die E-Mail-Adresse hat eine zustellbare Form,
//   - der Kontakt hat sich mindestens einmal angemeldet (lastLoginAt): Erst
//     die Anmeldung über den Link an diese Adresse bestätigt sie.
// Rollen im Tax-CMS dürfen auch Kontakte ohne Portalzugang haben; nur
// Anforderungen an sie unterbleiben.
// =============================================================================

/** Zustellbare Form einer Adresse (wie der Zustell-Worker). */
export const PORTAL_EMAIL_FORM = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Prisma-Filter des Mandanten: für das Portal zugelassen (wie die Portal-Anmeldung). */
export const MANDANT_PORTAL_OFFEN = {
  allowActive: true,
  anonymizedAt: null,
  mandateEndedAt: null,
} as const;

/**
 * Prisma-Filter für Kontakte mit aktivem Portalzugang (ohne die Form der
 * E-Mail-Adresse; die prüft `portalZugangMangel` nach dem Lesen).
 */
export function aktiverPortalzugangWhere(tenantId: string, mandantId: string) {
  return {
    tenantId,
    clientId: mandantId,
    active: true,
    lastLoginAt: { not: null },
    client: { ...MANDANT_PORTAL_OFFEN },
  };
}

/** Grund, warum ein Kontakt keinen aktiven Portalzugang hat (Reihenfolge wie der Worker). */
export type PortalZugangMangel =
  | 'MANDANT_INAKTIV'
  | 'KONTAKT_INAKTIV'
  | 'KONTAKT_OHNE_EMAIL'
  | 'KONTAKT_UNBESTAETIGT';

export interface PortalZugangDaten {
  active: boolean;
  email: string;
  lastLoginAt: Date | null;
  client: { allowActive: boolean; anonymizedAt: Date | null; mandateEndedAt: Date | null };
}

/** `null` bei aktivem Portalzugang, sonst der erste Mangel. */
export function portalZugangMangel(k: PortalZugangDaten): PortalZugangMangel | null {
  if (!k.client.allowActive || k.client.anonymizedAt || k.client.mandateEndedAt) {
    return 'MANDANT_INAKTIV';
  }
  if (!k.active) return 'KONTAKT_INAKTIV';
  if (!PORTAL_EMAIL_FORM.test(k.email.trim())) return 'KONTAKT_OHNE_EMAIL';
  if (!k.lastLoginAt) return 'KONTAKT_UNBESTAETIGT';
  return null;
}

/** Felder für `portalZugangMangel` (Prisma-select auf ClientContact). */
export const PORTAL_ZUGANG_SELECT = {
  active: true,
  email: true,
  lastLoginAt: true,
  client: { select: { allowActive: true, anonymizedAt: true, mandateEndedAt: true } },
} as const;

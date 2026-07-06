// =============================================================================
// Freiwillige Einwilligungen (Teil B der Datenschutzhinweise).
//
// Granulare, EINZELN erteilbare Einwilligungen nach DSGVO Art. 6 Abs. 1 lit. a
// (+ Art. 9 Abs. 2 lit. a bei besonderen Kategorien). Die Struktur bildet die
// vier Kategorien der Kanzlei-Vorlage ab. Geteilt zwischen Staff-Erfassung und
// Portal-Selbsterteilung; als JSON in client_consent.consents gespeichert.
// =============================================================================

import { z } from 'zod';

// --- B.1 Elektronische Kommunikation ---------------------------------------
export const CommunicationChannelSchema = z.object({
  /** Mandantenportal / sicherer Datenraum. */
  portal: z.boolean().default(false),
  /** E-Mail mit Transportverschlüsselung. */
  emailTls: z.boolean().default(false),
  /** Ende-zu-Ende-verschlüsselte E-Mail / verschlüsselte Dateiübermittlung. */
  emailE2e: z.boolean().default(false),
  /** Telefonische Kommunikation. */
  phone: z.boolean().default(false),
  /** Videokonferenz. */
  video: z.boolean().default(false),
  /** SMS / Messenger nur für organisatorische Kurzmitteilungen. */
  sms: z.boolean().default(false),
  /** Fax. */
  fax: z.boolean().default(false),
  /** Freitext-Details (Portal-Name, E-Mail-Adressen, Faxnummer, System …). */
  details: z.string().max(1000).default(''),
});
export type CommunicationChannels = z.infer<typeof CommunicationChannelSchema>;

// --- B.2 Kanzleimarketing / Informationen außerhalb des Mandats ------------
export const MarketingSchema = z.object({
  emailNewsletter: z.boolean().default(false),
  postal: z.boolean().default(false),
  phone: z.boolean().default(false),
  sms: z.boolean().default(false),
  details: z.string().max(1000).default(''),
});
export type MarketingConsent = z.infer<typeof MarketingSchema>;

// --- B.3 Übermittlung an konkret benannte Dritte ---------------------------
export const ThirdPartySchema = z.object({
  recipient: z.string().min(1).max(300),
  purpose: z.string().max(500).default(''),
  data: z.string().max(500).default(''),
  channel: z.string().max(200).default(''),
});
export type ThirdParty = z.infer<typeof ThirdPartySchema>;

// --- B.4 Mandatsbezogene Spezialdienstleister ------------------------------
export const SpecialistSchema = z.object({
  entity: z.string().min(1).max(300),
  service: z.string().max(500).default(''),
  accessType: z.string().max(500).default(''),
  requirements: z.string().max(500).default(''),
});
export type Specialist = z.infer<typeof SpecialistSchema>;

// --- Gesamtstruktur --------------------------------------------------------
export const ConsentSelectionsSchema = z.object({
  // prefault({}) füttert ein leeres Objekt als Eingabe, sodass die Feld-Defaults
  // der Sub-Schemata greifen (zod v4: .default() erwartet den Output-Typ).
  communication: CommunicationChannelSchema.prefault({}),
  marketing: MarketingSchema.prefault({}),
  thirdParties: z.array(ThirdPartySchema).max(50).default([]),
  specialists: z.array(SpecialistSchema).max(50).default([]),
});
export type ConsentSelections = z.infer<typeof ConsentSelectionsSchema>;

/** Leerer Einwilligungsstand (nichts angekreuzt = nichts eingewilligt). */
export function emptyConsent(): ConsentSelections {
  return ConsentSelectionsSchema.parse({});
}

/**
 * Parst einen persistierten (oder eingehenden) Einwilligungs-Datensatz robust:
 * fehlende Felder werden auf „nicht eingewilligt" defaultet. Wirft NICHT — bei
 * grob kaputtem Input gibt es den leeren Stand zurück (fail-safe: kein Consent).
 */
export function parseConsent(value: unknown): ConsentSelections {
  const r = ConsentSelectionsSchema.safeParse(value ?? {});
  return r.success ? r.data : emptyConsent();
}

/** Menschenlesbare Labels für die Anzeige/Zusammenfassung. */
export const COMMUNICATION_LABELS: Record<keyof Omit<CommunicationChannels, 'details'>, string> = {
  portal: 'Mandantenportal / sicherer Datenraum',
  emailTls: 'E-Mail (Transportverschlüsselung)',
  emailE2e: 'Ende-zu-Ende-verschlüsselte E-Mail / Dateiübermittlung',
  phone: 'Telefon',
  video: 'Videokonferenz',
  sms: 'SMS / Messenger (organisatorisch)',
  fax: 'Fax',
};

export const MARKETING_LABELS: Record<keyof Omit<MarketingConsent, 'details'>, string> = {
  emailNewsletter: 'E-Mail-Newsletter / Kanzleiinformationen',
  postal: 'Postalische Kanzleiinformationen',
  phone: 'Telefonische Hinweise (Veranstaltungen/Leistungen)',
  sms: 'SMS / Messenger-Hinweise',
};

/** Zählt die erteilten Einzeleinwilligungen (für Badges/Übersicht). */
export function countGranted(c: ConsentSelections): number {
  const commBools = (['portal', 'emailTls', 'emailE2e', 'phone', 'video', 'sms', 'fax'] as const)
    .filter((k) => c.communication[k]).length;
  const mktBools = (['emailNewsletter', 'postal', 'phone', 'sms'] as const)
    .filter((k) => c.marketing[k]).length;
  return commBools + mktBools + c.thirdParties.length + c.specialists.length;
}

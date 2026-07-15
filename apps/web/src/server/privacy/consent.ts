// =============================================================================
// Freiwillige Einwilligungen (Teil B der Datenschutzhinweise).
//
// Granulare, EINZELN erteilbare Einwilligungen nach DSGVO Art. 6 Abs. 1 lit. a
// (+ Art. 9 Abs. 2 lit. a bei besonderen Kategorien). Die Struktur bildet die
// vier Kategorien der Kanzlei-Vorlage ab. Geteilt zwischen Staff-Erfassung und
// Portal-Selbsterteilung; als JSON in client_consent.consents gespeichert.
// =============================================================================

import { z } from 'zod';

// --- Kanzlei-spezifischer Optionskatalog -----------------------------------
//
// Die stabilen IDs der bisherigen Checkboxen bleiben zugleich die Bruecke zum
// Legacy-JSON unten. Eigene Optionen erhalten eine UUID. Definitionen liegen
// tenant-spezifisch in `tenant_setting` (privacy.consent_options); ein Consent-
// Snapshot speichert die serverseitig aufgeloesten Labels und Dienstleister.
export const ConsentOptionSectionSchema = z.enum(['COMMUNICATION', 'MARKETING', 'OTHER']);
export type ConsentOptionSection = z.infer<typeof ConsentOptionSectionSchema>;

export const BUILTIN_CONSENT_OPTION_IDS = [
  'communication.portal',
  'communication.emailTls',
  'communication.emailE2e',
  'communication.phone',
  'communication.video',
  'communication.sms',
  'communication.fax',
  'marketing.emailNewsletter',
  'marketing.postal',
  'marketing.phone',
  'marketing.sms',
] as const;
export type BuiltinConsentOptionId = (typeof BUILTIN_CONSENT_OPTION_IDS)[number];

const BUILTIN_ID_SET = new Set<string>(BUILTIN_CONSENT_OPTION_IDS);

export function isBuiltinConsentOptionId(value: string): value is BuiltinConsentOptionId {
  return BUILTIN_ID_SET.has(value);
}

export const ConsentOptionDefinitionSchema = z.object({
  id: z.string().min(1).max(100),
  builtin: z.boolean(),
  section: ConsentOptionSectionSchema,
  label: z.string().trim().min(1).max(300),
  description: z.string().trim().max(1000).nullable().default(null),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(100_000),
  serviceProviderId: z.string().uuid().nullable().default(null),
});
export type ConsentOptionDefinition = z.infer<typeof ConsentOptionDefinitionSchema>;

export const ConsentOptionsCatalogSchema = z.object({
  version: z.literal(1),
  options: z.array(ConsentOptionDefinitionSchema).max(150),
});
export type ConsentOptionsCatalog = z.infer<typeof ConsentOptionsCatalogSchema>;

export const DEFAULT_CONSENT_OPTIONS: readonly ConsentOptionDefinition[] = [
  {
    id: 'communication.portal',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'Mandantenportal / sicherer Datenraum',
    description: null,
    active: true,
    sortOrder: 10,
    serviceProviderId: null,
  },
  {
    id: 'communication.emailTls',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'E-Mail (Transportverschlüsselung)',
    description: null,
    active: true,
    sortOrder: 20,
    serviceProviderId: null,
  },
  {
    id: 'communication.emailE2e',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'Ende-zu-Ende-verschlüsselte E-Mail / Dateiübermittlung',
    description: null,
    active: true,
    sortOrder: 30,
    serviceProviderId: null,
  },
  {
    id: 'communication.phone',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'Telefon',
    description: null,
    active: true,
    sortOrder: 40,
    serviceProviderId: null,
  },
  {
    id: 'communication.video',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'Videokonferenz',
    description: null,
    active: true,
    sortOrder: 50,
    serviceProviderId: null,
  },
  {
    id: 'communication.sms',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'SMS / Messenger (organisatorisch)',
    description: null,
    active: true,
    sortOrder: 60,
    serviceProviderId: null,
  },
  {
    id: 'communication.fax',
    builtin: true,
    section: 'COMMUNICATION',
    label: 'Fax',
    description: null,
    active: true,
    sortOrder: 70,
    serviceProviderId: null,
  },
  {
    id: 'marketing.emailNewsletter',
    builtin: true,
    section: 'MARKETING',
    label: 'E-Mail-Newsletter / Kanzleiinformationen',
    description: null,
    active: true,
    sortOrder: 110,
    serviceProviderId: null,
  },
  {
    id: 'marketing.postal',
    builtin: true,
    section: 'MARKETING',
    label: 'Postalische Kanzleiinformationen',
    description: null,
    active: true,
    sortOrder: 120,
    serviceProviderId: null,
  },
  {
    id: 'marketing.phone',
    builtin: true,
    section: 'MARKETING',
    label: 'Telefonische Hinweise (Veranstaltungen/Leistungen)',
    description: null,
    active: true,
    sortOrder: 130,
    serviceProviderId: null,
  },
  {
    id: 'marketing.sms',
    builtin: true,
    section: 'MARKETING',
    label: 'SMS / Messenger-Hinweise',
    description: null,
    active: true,
    sortOrder: 140,
    serviceProviderId: null,
  },
];

function cloneDefaultOption(option: ConsentOptionDefinition): ConsentOptionDefinition {
  return { ...option };
}

export function defaultConsentOptionsCatalog(): ConsentOptionsCatalog {
  return { version: 1, options: DEFAULT_CONSENT_OPTIONS.map(cloneDefaultOption) };
}

/**
 * Validiert den persistierten Tenant-Katalog und ergaenzt bei kuenftigen
 * Versionen fehlende Built-ins. Built-ins behalten ihre stabile Semantik und
 * ihr kanonisches Label; konfigurierbar sind Aktivitaet und Provider-Link.
 */
export function normalizeConsentOptionsCatalog(value: unknown): ConsentOptionsCatalog {
  const parsed = ConsentOptionsCatalogSchema.parse(value);
  const seen = new Set<string>();
  for (const option of parsed.options) {
    if (seen.has(option.id)) throw new Error(`Doppelte Einwilligungsoption: ${option.id}`);
    seen.add(option.id);
    if (isBuiltinConsentOptionId(option.id) !== option.builtin) {
      throw new Error(`Ungueltige Built-in-Kennzeichnung: ${option.id}`);
    }
    if (!option.builtin && !z.string().uuid().safeParse(option.id).success) {
      throw new Error(`Eigene Einwilligungsoption ohne UUID: ${option.id}`);
    }
  }

  const byId = new Map(parsed.options.map((option) => [option.id, option]));
  const builtins = DEFAULT_CONSENT_OPTIONS.map((canonical) => {
    const configured = byId.get(canonical.id);
    return {
      ...cloneDefaultOption(canonical),
      active: configured?.active ?? canonical.active,
      serviceProviderId: configured?.serviceProviderId ?? null,
    };
  });
  const custom = parsed.options
    .filter((option) => !option.builtin)
    .map((option) => ({
      ...option,
      label: option.label.trim(),
      description: option.description?.trim() || null,
    }));

  return {
    version: 1,
    options: [...builtins, ...custom].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'de'),
    ),
  };
}

export const ConsentServiceProviderSnapshotSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(300),
  category: z.string().max(200),
  // Defaults keep snapshots written before the AVV linkage extension readable.
  hasDataAccess: z.boolean().nullable().default(null),
  contractFromDate: z.string().date().nullable().default(null),
  contractToDate: z.string().date().nullable().default(null),
});
export type ConsentServiceProviderSnapshot = z.infer<typeof ConsentServiceProviderSnapshotSchema>;

export const ConsentOptionSelectionSnapshotSchema = z.object({
  optionId: z.string().min(1).max(100),
  labelSnapshot: z.string().min(1).max(300),
  section: ConsentOptionSectionSchema,
  serviceProviderSnapshot: ConsentServiceProviderSnapshotSchema.nullable().default(null),
});
export type ConsentOptionSelectionSnapshot = z.infer<typeof ConsentOptionSelectionSnapshotSchema>;

/** Aufgeloeste Anzeige-Definition; nur diese Form geht an Staff-/Public-UI. */
export type ResolvedConsentOption = ConsentOptionDefinition & {
  serviceProvider: ConsentServiceProviderSnapshot | null;
  providerMissing: boolean;
};

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
  // V2: Selbstbeschreibender Snapshot aller ausgewaehlten Katalogoptionen.
  // Bei Legacy-Datensaetzen fehlt das Feld; die bisherigen Bool-Werte bleiben
  // weiterhin massgeblich und werden beim naechsten Snapshot serverseitig
  // kanonisch ergaenzt. Eigene Optionen werden ueber ihre stabile UUID erkannt.
  optionSelections: z
    .array(ConsentOptionSelectionSnapshotSchema)
    .max(150)
    .default([])
    .superRefine((selections, ctx) => {
      const seen = new Set<string>();
      for (const [index, selection] of selections.entries()) {
        if (seen.has(selection.optionId)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'optionId'],
            message: 'Einwilligungsoption doppelt ausgewaehlt.',
          });
        }
        seen.add(selection.optionId);
      }
    }),
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
  const commBools = (
    ['portal', 'emailTls', 'emailE2e', 'phone', 'video', 'sms', 'fax'] as const
  ).filter((k) => c.communication[k]).length;
  const mktBools = (['emailNewsletter', 'postal', 'phone', 'sms'] as const).filter(
    (k) => c.marketing[k],
  ).length;
  const customOptionIds = new Set(
    c.optionSelections
      .filter((selection) => !isBuiltinConsentOptionId(selection.optionId))
      .map((selection) => selection.optionId),
  );
  return commBools + mktBools + customOptionIds.size + c.thirdParties.length + c.specialists.length;
}

/** Aus den Legacy-Bools abgeleitete, stabil benannte Built-in-Auswahl. */
export function selectedBuiltinConsentOptionIds(c: ConsentSelections): BuiltinConsentOptionId[] {
  return BUILTIN_CONSENT_OPTION_IDS.filter((id) => isBuiltinConsentSelected(c, id));
}

export function isBuiltinConsentSelected(
  c: ConsentSelections,
  id: BuiltinConsentOptionId,
): boolean {
  switch (id) {
    case 'communication.portal':
      return c.communication.portal;
    case 'communication.emailTls':
      return c.communication.emailTls;
    case 'communication.emailE2e':
      return c.communication.emailE2e;
    case 'communication.phone':
      return c.communication.phone;
    case 'communication.video':
      return c.communication.video;
    case 'communication.sms':
      return c.communication.sms;
    case 'communication.fax':
      return c.communication.fax;
    case 'marketing.emailNewsletter':
      return c.marketing.emailNewsletter;
    case 'marketing.postal':
      return c.marketing.postal;
    case 'marketing.phone':
      return c.marketing.phone;
    case 'marketing.sms':
      return c.marketing.sms;
  }
}

export function setBuiltinConsentSelected(
  c: ConsentSelections,
  id: BuiltinConsentOptionId,
  selected: boolean,
): ConsentSelections {
  const next: ConsentSelections = {
    ...c,
    communication: { ...c.communication },
    marketing: { ...c.marketing },
  };
  switch (id) {
    case 'communication.portal':
      next.communication.portal = selected;
      break;
    case 'communication.emailTls':
      next.communication.emailTls = selected;
      break;
    case 'communication.emailE2e':
      next.communication.emailE2e = selected;
      break;
    case 'communication.phone':
      next.communication.phone = selected;
      break;
    case 'communication.video':
      next.communication.video = selected;
      break;
    case 'communication.sms':
      next.communication.sms = selected;
      break;
    case 'communication.fax':
      next.communication.fax = selected;
      break;
    case 'marketing.emailNewsletter':
      next.marketing.emailNewsletter = selected;
      break;
    case 'marketing.postal':
      next.marketing.postal = selected;
      break;
    case 'marketing.phone':
      next.marketing.phone = selected;
      break;
    case 'marketing.sms':
      next.marketing.sms = selected;
      break;
  }
  return next;
}

/**
 * Erkennt auch einen TEIL-Widerruf: jede zuvor erteilte boolesche Auswahl oder
 * konkret benannte Freigabe, die im neuen Snapshot fehlt, ist ein Widerruf —
 * selbst wenn gleichzeitig andere Einwilligungen neu erteilt werden.
 */
export function hasConsentRevocation(
  previous: ConsentSelections,
  next: ConsentSelections,
): boolean {
  const communicationKeys = [
    'portal',
    'emailTls',
    'emailE2e',
    'phone',
    'video',
    'sms',
    'fax',
  ] as const;
  if (communicationKeys.some((key) => previous.communication[key] && !next.communication[key])) {
    return true;
  }

  const marketingKeys = ['emailNewsletter', 'postal', 'phone', 'sms'] as const;
  if (marketingKeys.some((key) => previous.marketing[key] && !next.marketing[key])) {
    return true;
  }

  const stable = (value: unknown) => JSON.stringify(value);
  const nextThirdParties = new Set(next.thirdParties.map(stable));
  if (previous.thirdParties.some((entry) => !nextThirdParties.has(stable(entry)))) return true;

  const nextSpecialists = new Set(next.specialists.map(stable));
  if (previous.specialists.some((entry) => !nextSpecialists.has(stable(entry)))) return true;

  // Labels und Provider koennen sich im Katalog aendern, ohne dass die
  // Einwilligung widerrufen wird. Fuer eigene Optionen zaehlt nur die stabile ID.
  const nextCustomIds = new Set(
    next.optionSelections
      .filter((selection) => !isBuiltinConsentOptionId(selection.optionId))
      .map((selection) => selection.optionId),
  );
  return previous.optionSelections
    .filter((selection) => !isBuiltinConsentOptionId(selection.optionId))
    .some((selection) => !nextCustomIds.has(selection.optionId));
}

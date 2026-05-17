// =============================================================================
// Vordefinierte RFC-3161-TSA-Anbieter
//
// Liste der Zeitstempel-Behörden, die in der UI auswählbar sind. Auswahl liegt
// pro Tenant in `tenant_setting.evidence.tsa`. ENV `TIMESTAMP_AUTHORITY_URL`
// dient als Fallback, wenn nichts gewählt ist.
// =============================================================================

export interface TsaProvider {
  id: string;
  label: string;
  url: string;
  cost: 'free' | 'commercial';
  jurisdiction: string;
  qualified: boolean;    // eIDAS-qualifizierte TSA?
  hint: string;
}

export const TSA_PROVIDERS: TsaProvider[] = [
  {
    id: 'freetsa',
    label: 'FreeTSA',
    url: 'https://freetsa.org/tsr',
    cost: 'free',
    jurisdiction: 'DE',
    qualified: false,
    hint: 'Kostenlos und ohne Anmeldung. Geeignet für Test- und Entwicklungsbetrieb. Nicht eIDAS-qualifiziert.',
  },
  {
    id: 'digicert',
    label: 'DigiCert',
    url: 'http://timestamp.digicert.com',
    cost: 'free',
    jurisdiction: 'US',
    qualified: false,
    hint: 'Kostenloser Code-Signing-Standard, weltweit verbreitet. Nicht eIDAS-qualifiziert (US-CA).',
  },
  {
    id: 'sectigo',
    label: 'Sectigo (ehem. Comodo)',
    url: 'http://timestamp.sectigo.com',
    cost: 'free',
    jurisdiction: 'GB',
    qualified: false,
    hint: 'Kostenlos, gehörte früher zu Comodo. Nicht eIDAS-qualifiziert.',
  },
  {
    id: 'globalsign',
    label: 'GlobalSign',
    url: 'http://timestamp.globalsign.com/tsa/r6advanced1',
    cost: 'free',
    jurisdiction: 'BE',
    qualified: false,
    hint: 'Kostenlos, in der EU ansässig. Nicht eIDAS-qualifiziert.',
  },
  {
    id: 'apple',
    label: 'Apple',
    url: 'http://timestamp.apple.com/ts01',
    cost: 'free',
    jurisdiction: 'US',
    qualified: false,
    hint: 'Kostenlos, hohe Verfügbarkeit. Nicht eIDAS-qualifiziert.',
  },
  {
    id: 'dtrust',
    label: 'D-Trust (Bundesdruckerei)',
    url: 'https://tsa.d-trust.net/timestamp',
    cost: 'commercial',
    jurisdiction: 'DE',
    qualified: true,
    hint: 'eIDAS-qualifizierte TSA der Bundesdruckerei. Empfohlen für produktiven Einsatz in deutschen Kanzleien. Kostenpflichtiges Konto erforderlich.',
  },
  {
    id: 'swisscom',
    label: 'Swisscom',
    url: 'http://tsa.swisscom.com/CN=Swisscom%20Root%20CA%202',
    cost: 'commercial',
    jurisdiction: 'CH',
    qualified: true,
    hint: 'eIDAS-qualifizierte TSA aus der Schweiz. Kostenpflichtig.',
  },
  {
    id: 'custom',
    label: 'Eigener TSA-Server',
    url: '',
    cost: 'free',
    jurisdiction: '—',
    qualified: false,
    hint: 'Eigene URL angeben — z. B. interner Stempeldienst der Kanzlei.',
  },
];

export function getTsaProvider(id: string): TsaProvider | undefined {
  return TSA_PROVIDERS.find((p) => p.id === id);
}

export function resolveTsaUrl(providerId: string | null, customUrl: string | null): string | null {
  if (!providerId) return null;
  if (providerId === 'custom') return customUrl?.trim() || null;
  const p = getTsaProvider(providerId);
  return p?.url || null;
}

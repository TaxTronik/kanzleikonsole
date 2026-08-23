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
  /** Nur true, wenn genau dieses Preset die Qualifikation technisch belegt.
   * Ein Anbietername oder ein RFC-3161-Endpunkt allein reicht dafür nicht. */
  qualified: boolean;
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
    hint: 'Standard-Anbieter: kostenlos, in der EU ansässig. Antworten werden kryptografisch gegen den eingebetteten Root „GlobalSign Root CA - R6" geprüft. Nicht eIDAS-qualifiziert. Wenn ein qualifizierter Dienst benötigt wird, muss der Betreiber Vertrag, konkreten Endpunkt und EU-Vertrauenslistenstatus prüfen.',
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
    qualified: false,
    hint: 'D-Trust bietet qualifizierte Zeitstempeldienste an. Ob Vertrag, Endpunkt und Zertifikatskette dieses Presets einen qualifizierten Dienst ergeben, muss der Betreiber anhand Vertrag und EU-Vertrauensliste prüfen.',
  },
  {
    id: 'swisscom',
    label: 'Swisscom',
    url: 'http://tsa.swisscom.com/CN=Swisscom%20Root%20CA%202',
    cost: 'commercial',
    jurisdiction: 'CH',
    qualified: false,
    hint: 'Swisscom bietet kommerzielle Zeitstempeldienste an. TaxTronik sagt für dieses Preset keine eIDAS-Qualifikation zu; Vertrag, Endpunkt und Vertrauensstatus sind separat zu prüfen.',
  },
  {
    id: 'custom',
    label: 'Eigener TSA-Server',
    url: '',
    cost: 'free',
    jurisdiction: '—',
    qualified: false,
    hint: 'Eigene öffentlich auflösbare HTTP(S)-URL angeben; HTTPS wird empfohlen. Private, Loopback- und interne Netzadressen werden als SSRF-Schutz abgelehnt.',
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

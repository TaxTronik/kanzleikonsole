// =============================================================================
// Steuerschätzungs-Engine (regelbasiert)
//
// Achtung: Diese Schätzung ersetzt keine fachliche Beurteilung. Sie dient
// ausschließlich dazu, dem Mandanten eine Größenordnung zu zeigen. UI muss
// einen sichtbaren Disclaimer enthalten.
//
// Quellen / Stand 2025:
//   - KSt: 15 %  (§ 23 KStG) + 5,5 % SolZ darauf
//   - GewSt: Steuermesszahl 3,5 %, kommunaler Hebesatz konfigurierbar
//            (Default 400 % München); Freibetrag 24.500 € nur für PNS/PG.
//   - USt-Zahllast: Erlöse * 19 % - Vorsteuer (vereinfacht)
//   - ESt: progressiv, vereinfachte Approximation für Einkommen aus Gewerbebetrieb
//
// Inputs sind die KPIs aus addison-parser.computeBwaKpis + Zusatzparameter.
// =============================================================================

export type LegalForm = 'GMBH' | 'AG' | 'UG' | 'EINZELUNTERNEHMEN' | 'GBR' | 'OHG' | 'KG';

export interface TaxEstimationInput {
  legalForm: LegalForm;
  // Bemessungsbasis: Ergebnis VOR Ertragsteuern (EUR). Wenn nur ein Nach-Steuer-
  // Ergebnis verfügbar war, `resultIsAfterTax: true` setzen (Disclaimer).
  result: number;
  /** True, wenn `result` das Ergebnis NACH Steuern ist (Zirkelbezug möglich). */
  resultIsAfterTax?: boolean;
  // Erlöse (Pos 1990 in BWA, EUR) — für USt-Schätzung
  revenue: number | null;
  // Vorsteuer (Pos 3190 in BWA, EUR)
  inputVat: number | null;
  // USt-Zahlungen bisher geleistet (Pos 3200, EUR)
  vatPaid: number | null;
  // Gewerbesteuer-Hebesatz der Gemeinde (in %, z.B. 400 für 400%)
  gewerbesteuerHebesatzPct: number;
  // Bei Personengesellschaften: Anzahl Gesellschafter (für Freibetrag)
  isPersonengesellschaft?: boolean;
}

export interface TaxEstimationResult {
  // Gewerbesteuer
  gewerbesteuer: number;
  gewerbesteuerBemessung: number;
  gewerbesteuerFreibetrag: number;
  // Körperschaftsteuer (nur Kapitalgesellschaften)
  koerperschaftsteuer: number | null;
  solidaritaetszuschlag: number | null;
  // USt-Schätzung (Jahres-Saldo: zu zahlen + bzw. - schon gezahlt)
  ustZahllast: number | null;
  ustOffenerSaldo: number | null;
  // ESt (nur Einzelunternehmen / Personengesellschaft, Annahme: Single)
  einkommensteuerSchaetzung: number | null;
  // Gesamt
  gesamt: number;
  disclaimers: string[];
}

const SOLZ_RATE = 0.055; // 5,5 % auf KSt
const KST_RATE = 0.15;
const GEWST_MESSZAHL = 0.035; // 3,5 %
const GEWST_FREIBETRAG = 24_500; // nur für nat. Personen / PG
const USt_RATE = 0.19;

/** Vereinfachte Einkommensteuer-Tabelle 2025 (Grundtarif, Single).
 *  Quelle: § 32a EStG. Werte gerundet. */
function einkommensteuer2025(zvE: number): number {
  if (zvE <= 12_096) return 0;
  if (zvE <= 17_443) {
    const y = (zvE - 12_096) / 10_000;
    return Math.round((932.3 * y + 1_400) * y);
  }
  if (zvE <= 68_480) {
    const z = (zvE - 17_443) / 10_000;
    return Math.round((176.64 * z + 2_397) * z + 1_015.13);
  }
  if (zvE <= 277_825) {
    return Math.round(0.42 * zvE - 10_911.92);
  }
  return Math.round(0.45 * zvE - 19_246.67);
}

export function estimateTaxes(input: TaxEstimationInput): TaxEstimationResult {
  const disclaimers: string[] = [
    'Diese Schätzung ist eine grobe Orientierung und ersetzt keine fachliche Beurteilung.',
    'Werte basieren auf der vorläufigen BWA und Standard-Sätzen 2025.',
  ];
  if (input.resultIsAfterTax) {
    disclaimers.push(
      'Kein „Ergebnis vor Steuern" in der BWA gefunden (DATEV 1345/1300) — die Schätzung nutzt das vorläufige Ergebnis; die tatsächliche Steuerlast kann dadurch systematisch unterschätzt sein.',
    );
  }

  const isKap = input.legalForm === 'GMBH' || input.legalForm === 'AG' || input.legalForm === 'UG';
  const isPnP = input.isPersonengesellschaft || input.legalForm === 'GBR' || input.legalForm === 'OHG' || input.legalForm === 'KG' || input.legalForm === 'EINZELUNTERNEHMEN';

  // Gewerbesteuer
  const gewerbesteuerFreibetrag = isPnP ? GEWST_FREIBETRAG : 0;
  const gewerbesteuerBemessung = Math.max(0, input.result - gewerbesteuerFreibetrag);
  const gewerbesteuerMessbetrag = gewerbesteuerBemessung * GEWST_MESSZAHL;
  const gewerbesteuer = Math.round(gewerbesteuerMessbetrag * (input.gewerbesteuerHebesatzPct / 100));

  // KSt + SolZ (nur Kapital)
  let koerperschaftsteuer: number | null = null;
  let solidaritaetszuschlag: number | null = null;
  if (isKap) {
    koerperschaftsteuer = Math.round(Math.max(0, input.result) * KST_RATE);
    solidaritaetszuschlag = Math.round(koerperschaftsteuer * SOLZ_RATE);
  }

  // USt
  let ustZahllast: number | null = null;
  let ustOffenerSaldo: number | null = null;
  if (input.revenue !== null) {
    const ustErhoben = Math.round(input.revenue * USt_RATE);
    const vorsteuer = input.inputVat ?? 0;
    ustZahllast = ustErhoben - Math.round(vorsteuer);
    if (input.vatPaid !== null) {
      ustOffenerSaldo = ustZahllast - Math.round(input.vatPaid);
    }
    disclaimers.push('USt-Schätzung: Annahme Regelsteuersatz 19 % auf alle Erlöse.');
  }

  // ESt (nur Einzelunternehmen — bei PG wäre individuelle Aufteilung nötig)
  let einkommensteuerSchaetzung: number | null = null;
  if (input.legalForm === 'EINZELUNTERNEHMEN') {
    // § 4 Abs. 5b EStG: Die Gewerbesteuer ist seit 2008 KEINE Betriebsausgabe —
    // die gewerblichen Einkünfte sind daher das VOLLE Ergebnis (nicht abzüglich
    // GewSt). Die Doppelbelastung mildert § 35 EStG über eine Steuerermäßigung.
    const gewerblicheEinkuenfte = Math.max(0, input.result);
    const estTariflich = einkommensteuer2025(gewerblicheEinkuenfte);
    // § 35 Abs. 1 EStG: Ermäßigung = das 4,0-fache des Gewerbesteuer-Messbetrags,
    // gedeckelt auf die tatsächlich gezahlte Gewerbesteuer und die tarifliche ESt.
    const gewStAnrechnung = Math.min(
      Math.round(4 * gewerbesteuerMessbetrag),
      gewerbesteuer,
      estTariflich,
    );
    einkommensteuerSchaetzung = Math.max(0, estTariflich - gewStAnrechnung);
    disclaimers.push('ESt: Annahme Single, Grundtarif 2025, gewerbliche Einkünfte (§ 4 Abs. 5b EStG: GewSt nicht abzugsfähig) mit Anrechnung nach § 35 EStG (4,0 × Messbetrag). Persönliche Faktoren (Familienstand, Sonderausgaben, weitere Einkünfte) nicht berücksichtigt.');
  }

  let gesamt = gewerbesteuer;
  if (koerperschaftsteuer !== null) gesamt += koerperschaftsteuer;
  if (solidaritaetszuschlag !== null) gesamt += solidaritaetszuschlag;
  if (einkommensteuerSchaetzung !== null) gesamt += einkommensteuerSchaetzung;

  return {
    gewerbesteuer,
    gewerbesteuerBemessung,
    gewerbesteuerFreibetrag,
    koerperschaftsteuer,
    solidaritaetszuschlag,
    ustZahllast,
    ustOffenerSaldo,
    einkommensteuerSchaetzung,
    gesamt,
    disclaimers,
  };
}

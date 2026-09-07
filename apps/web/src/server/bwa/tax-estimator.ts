// =============================================================================
// Steuerschätzungs-Engine (regelbasiert)
//
// Achtung: Diese Schätzung ersetzt keine fachliche Beurteilung. Sie dient
// ausschließlich dazu, dem Mandanten eine Größenordnung zu zeigen. UI muss
// einen sichtbaren Disclaimer enthalten.
//
// Quellen / Stand 2026:
//   - KSt: 15 %  (§ 23 KStG) + 5,5 % SolZ darauf
//   - GewSt: Steuermesszahl 3,5 %, kommunaler Hebesatz konfigurierbar
//            (UI-Vorbelegung 400 %, kommunal zu prüfen); Freibetrag 24.500 €
//            nur für natürliche Personen/Personengesellschaften.
//   - USt-Zahllast: Erlöse * 19 % - Vorsteuer (vereinfacht)
//   - ESt: progressiv, vereinfachte Approximation für Einkommen aus Gewerbebetrieb
//
// Inputs sind die KPIs aus addison-parser.computeBwaKpis + Zusatzparameter.
// =============================================================================

export type LegalForm = 'GMBH' | 'AG' | 'UG' | 'EINZELUNTERNEHMEN' | 'GBR' | 'OHG' | 'KG';

export interface TaxEstimationInput {
  /** Veranlagungsjahr der BWA. Unbekannte Tarife werden fail-safe nicht geschätzt. */
  taxYear: number;
  legalForm: LegalForm;
  // Bemessungsbasis: Ergebnis VOR Ertragsteuern (EUR).
  result: number;
  /** Bekannte Nachsteuerbasis wird ausdrücklich abgewiesen. */
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
  /** True bei freiberuflicher Tätigkeit (§ 18 EStG) — keine Gewerbesteuer
   *  (§ 2 GewStG erfasst nur den Gewerbebetrieb). */
  isFreiberufler?: boolean;
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

interface GrundtarifParameters {
  allowance: number;
  firstZoneEnd: number;
  secondZoneEnd: number;
  yFactor: number;
  zFactor: number;
  zBase: number;
  firstLinearOffset: number;
  secondLinearOffset: number;
}

// Amtliche Parameter § 32a Abs. 1 EStG. Bewusst jahrgangsbezogen: einen alten
// Tarif still auf neue BWA-Perioden anzuwenden wäre fachlich gefährlicher als
// die Schätzung für ein noch nicht hinterlegtes Jahr auszulassen.
const GRUNDTARIF: Record<number, GrundtarifParameters> = {
  2025: {
    allowance: 12_096,
    firstZoneEnd: 17_443,
    secondZoneEnd: 68_480,
    yFactor: 932.3,
    zFactor: 176.64,
    zBase: 1_015.13,
    firstLinearOffset: 10_911.92,
    secondLinearOffset: 19_246.67,
  },
  2026: {
    allowance: 12_348,
    firstZoneEnd: 17_799,
    secondZoneEnd: 69_878,
    yFactor: 914.51,
    zFactor: 173.1,
    zBase: 1_034.87,
    firstLinearOffset: 11_135.63,
    secondLinearOffset: 19_470.38,
  },
};

/** Grundtarif (Single) nach § 32a Abs. 1; Ergebnis auf volle Euro abgerundet. */
export function einkommensteuerGrundtarif(taxYear: number, zvE: number): number | null {
  const p = GRUNDTARIF[taxYear];
  if (!p) return null;
  const x = Math.floor(Math.max(0, zvE));
  let tax: number;
  if (x <= p.allowance) return 0;
  if (x <= p.firstZoneEnd) {
    const y = (x - p.allowance) / 10_000;
    tax = (p.yFactor * y + 1_400) * y;
  } else if (x <= p.secondZoneEnd) {
    const z = (x - p.firstZoneEnd) / 10_000;
    tax = (p.zFactor * z + 2_397) * z + p.zBase;
  } else if (x <= 277_825) {
    tax = 0.42 * x - p.firstLinearOffset;
  } else {
    tax = 0.45 * x - p.secondLinearOffset;
  }
  return Math.floor(tax);
}

function estimateVat(
  input: TaxEstimationInput,
  disclaimers: string[],
): Pick<TaxEstimationResult, 'ustZahllast' | 'ustOffenerSaldo'> {
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
  return { ustZahllast, ustOffenerSaldo };
}

export function estimateTaxes(input: TaxEstimationInput): TaxEstimationResult {
  if (input.resultIsAfterTax) {
    throw new Error(
      'Für die Steuerschätzung ist ein Ergebnis vor Steuern erforderlich. Ein Nachsteuerergebnis darf es nicht ersetzen.',
    );
  }
  const disclaimers: string[] = [
    'Diese Schätzung ist eine grobe Orientierung und ersetzt keine fachliche Beurteilung.',
    `Werte basieren auf der vorläufigen BWA; Einkommensteuer-Grundtarif ${input.taxYear}.`,
  ];

  const isKap = input.legalForm === 'GMBH' || input.legalForm === 'AG' || input.legalForm === 'UG';
  const isPnP =
    input.isPersonengesellschaft ||
    input.legalForm === 'GBR' ||
    input.legalForm === 'OHG' ||
    input.legalForm === 'KG' ||
    input.legalForm === 'EINZELUNTERNEHMEN';

  // Gewerbesteuer. § 2 GewStG erfasst nur den Gewerbebetrieb — Freiberufler
  // (§ 18 EStG) sind NICHT gewerbesteuerpflichtig; dann bleiben GewSt-Bemessung,
  // -Messbetrag und -Betrag (und damit auch die § 35-Anrechnung unten) 0.
  const gewerbesteuerpflichtig = !input.isFreiberufler;
  const gewerbesteuerFreibetrag = gewerbesteuerpflichtig && isPnP ? GEWST_FREIBETRAG : 0;
  // § 11 Abs. 1 GewStG: Gewerbeertrag zunächst auf volle 100 Euro nach unten
  // abrunden, erst danach ggf. den Freibetrag abziehen.
  const gewerbeertragAbgerundet = Math.floor(Math.max(0, input.result) / 100) * 100;
  const gewerbesteuerBemessung = gewerbesteuerpflichtig
    ? Math.max(0, gewerbeertragAbgerundet - gewerbesteuerFreibetrag)
    : 0;
  const gewerbesteuerMessbetrag = gewerbesteuerBemessung * GEWST_MESSZAHL;
  const gewerbesteuer = Math.round(
    gewerbesteuerMessbetrag * (input.gewerbesteuerHebesatzPct / 100),
  );
  if (input.isFreiberufler) {
    disclaimers.push('Freiberufliche Tätigkeit (§ 18 EStG): keine Gewerbesteuer angesetzt.');
  } else {
    disclaimers.push(
      'Gewerbesteuer vereinfacht aus dem BWA-Ergebnis; Hinzurechnungen und Kürzungen des Gewerbeertrags sind nicht modelliert.',
    );
  }

  // KSt + SolZ (nur Kapital)
  let koerperschaftsteuer: number | null = null;
  let solidaritaetszuschlag: number | null = null;
  if (isKap) {
    koerperschaftsteuer = Math.round(Math.max(0, input.result) * KST_RATE);
    solidaritaetszuschlag = Math.round(koerperschaftsteuer * SOLZ_RATE);
  }

  const { ustZahllast, ustOffenerSaldo } = estimateVat(input, disclaimers);

  // ESt (nur Einzelunternehmen — bei PG wäre individuelle Aufteilung nötig)
  let einkommensteuerSchaetzung: number | null = null;
  if (input.legalForm === 'EINZELUNTERNEHMEN') {
    // § 4 Abs. 5b EStG: Die Gewerbesteuer ist seit 2008 KEINE Betriebsausgabe —
    // die gewerblichen Einkünfte sind daher das VOLLE Ergebnis (nicht abzüglich
    // GewSt). Die Doppelbelastung mildert § 35 EStG über eine Steuerermäßigung.
    const gewerblicheEinkuenfte = Math.max(0, input.result);
    const estTariflich = einkommensteuerGrundtarif(input.taxYear, gewerblicheEinkuenfte);
    if (estTariflich === null) {
      disclaimers.push(
        `Für ${input.taxYear} ist kein verifizierter §-32a-Tarif hinterlegt; die Einkommensteuer wird deshalb nicht geschätzt.`,
      );
    } else {
      // § 35 Abs. 1 EStG: Ermäßigung = das 4,0-fache des Gewerbesteuer-Messbetrags,
      // gedeckelt auf die tatsächlich gezahlte Gewerbesteuer und die tarifliche ESt.
      const gewStAnrechnung = Math.min(
        Math.round(4 * gewerbesteuerMessbetrag),
        gewerbesteuer,
        estTariflich,
      );
      einkommensteuerSchaetzung = Math.max(0, estTariflich - gewStAnrechnung);
      disclaimers.push(
        `ESt: Annahme Single, Grundtarif ${input.taxYear}, gewerbliche Einkünfte (§ 4 Abs. 5b EStG: GewSt nicht abzugsfähig) mit Anrechnung nach § 35 EStG (4,0 × Messbetrag). Persönliche Faktoren (Familienstand, Sonderausgaben, weitere Einkünfte) nicht berücksichtigt.`,
      );
    }
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

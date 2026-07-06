// =============================================================================
// GwG-Risk-Score-Engine
//
// Regelbasierte Risikobewertung. Faktoren werden vom Mitarbeiter beantwortet
// (z. B. „Sitz in Hochrisikoland?"), Gewichte kommen aus tenant_setting
// (`gwg.risk_weights`) — Default-Werte siehe DEFAULT_WEIGHTS unten.
//
// Score = Σ (answer_value * weight)
// Schwellen → Risk-Level: < 10 LOW, < 25 MEDIUM, sonst HIGH
//
// Pro Antwort:
//   - 0 = kein Risiko
//   - 1 = leicht erhöht
//   - 2 = erhöht
//   - 3 = stark erhöht (PEP, Hochrisikoland, etc.)
// =============================================================================

export interface RiskFactor {
  key: string;
  label: string;
  // Mögliche Antwort-Optionen mit Risikowert (UI-Auswahl)
  options: Array<{ value: number; label: string }>;
}

export interface RiskWeights {
  [factorKey: string]: number;
}

export const DEFAULT_FACTORS: RiskFactor[] = [
  {
    key: 'jurisdiction',
    label: 'Sitz / Wohnsitz des Mandanten',
    options: [
      { value: 0, label: 'Deutschland / EU' },
      { value: 1, label: 'OECD-Land außerhalb EU' },
      { value: 2, label: 'Drittland mit niedrigem Risiko' },
      { value: 3, label: 'Hochrisikoland (FATF-Liste)' },
    ],
  },
  {
    key: 'industry',
    label: 'Branche',
    options: [
      { value: 0, label: 'Standardbranche (Handel, Dienstleistung)' },
      { value: 1, label: 'Bau, Logistik, Gastronomie' },
      { value: 2, label: 'Immobilien, Edelmetallhandel, Kunst' },
      { value: 3, label: 'Glücksspiel, Krypto, Bargeld-intensiv' },
    ],
  },
  {
    key: 'pep',
    label: 'Politisch exponierte Person (PEP) im Mandantenkreis',
    options: [
      { value: 0, label: 'Keine PEP' },
      { value: 3, label: 'PEP oder enges Familienmitglied einer PEP' },
    ],
  },
  {
    key: 'cash_intensity',
    label: 'Bargeld-Intensität',
    options: [
      { value: 0, label: 'Wenig bis keine Bargeldumsätze' },
      { value: 1, label: 'Gemischt' },
      { value: 2, label: 'Überwiegend Bargeld' },
      { value: 3, label: 'Ausschließlich Bargeld' },
    ],
  },
  {
    key: 'transparency',
    label: 'Eigentümer-Transparenz',
    options: [
      { value: 0, label: 'Eigentumsstruktur klar dokumentiert' },
      { value: 1, label: 'Beteiligungen über Treuhand' },
      { value: 2, label: 'Komplexe Verschachtelung über Drittstaaten' },
      { value: 3, label: 'Wirtschaftlich Berechtigte nicht ermittelbar' },
    ],
  },
  {
    key: 'transaction_complexity',
    label: 'Geschäftsmodell',
    options: [
      { value: 0, label: 'Klar strukturiertes, branchenübliches Modell' },
      { value: 1, label: 'Häufig wechselnde Geschäftsbeziehungen' },
      { value: 2, label: 'Internationale Strukturen, Verrechnungspreise' },
      { value: 3, label: 'Strukturen ohne erkennbaren wirtschaftlichen Zweck' },
    ],
  },
];

export const DEFAULT_WEIGHTS: RiskWeights = {
  jurisdiction: 4,
  industry: 3,
  pep: 5,
  cash_intensity: 3,
  transparency: 4,
  transaction_complexity: 2,
};

const LOW_THRESHOLD = 10;
const MEDIUM_THRESHOLD = 25;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskBreakdown {
  factor: string;
  label: string;
  answer: number;
  answerLabel: string | null;
  weight: number;
  contribution: number;
}

export interface RiskResult {
  score: number;
  level: RiskLevel;
  breakdown: RiskBreakdown[];
  // Wiederholungsfrist: Hochrisiko = 1 Jahr, sonst 3 Jahre
  validForDays: number;
  /** True, wenn die Stufe durch den PEP-Override (§ 15 GwG) erzwungen wurde. */
  pepOverride: boolean;
}

/**
 * Wiederholungs-/Aktualisierungsfrist je Risikostufe (§ 10 Abs. 1 Nr. 5 GwG):
 * Hochrisiko jährlich, sonst alle 3 Jahre. EINZIGE Quelle (vorher doppelt
 * hartkodiert in risk-score und der Verify-Action).
 */
export function riskValidForDays(level: RiskLevel): number {
  return level === 'HIGH' ? 365 : 365 * 3;
}

export function computeRiskScore(
  answers: Record<string, number>,
  weights: RiskWeights = DEFAULT_WEIGHTS,
  factors: RiskFactor[] = DEFAULT_FACTORS,
): RiskResult {
  let score = 0;
  const breakdown: RiskBreakdown[] = [];

  for (const f of factors) {
    const ans = answers[f.key] ?? 0;
    const w = weights[f.key] ?? 0;
    const contribution = ans * w;
    score += contribution;
    breakdown.push({
      factor: f.key,
      label: f.label,
      answer: ans,
      answerLabel: f.options.find((o) => o.value === ans)?.label ?? null,
      weight: w,
      contribution,
    });
  }

  const scoreLevel: RiskLevel =
    score < LOW_THRESHOLD ? 'LOW' : score < MEDIUM_THRESHOLD ? 'MEDIUM' : 'HIGH';

  // § 15 Abs. 3 Nr. 1 i.V.m. Abs. 4 GwG: Eine politisch exponierte Person (oder
  // ein enges Familienmitglied) ist ein ZWINGENDER Fall verstärkter Sorgfalts-
  // pflichten mit kontinuierlicher/jährlicher Überwachung — unabhängig vom
  // gewichteten Score immer HIGH. Vorher konnte PEP (3×5=15 < 25) als MEDIUM
  // mit 3-Jahres-Frist durchlaufen.
  const pepOverride = (answers['pep'] ?? 0) >= 1;
  const level: RiskLevel = pepOverride ? 'HIGH' : scoreLevel;

  const validForDays = riskValidForDays(level);

  return { score, level, breakdown, validForDays, pepOverride };
}

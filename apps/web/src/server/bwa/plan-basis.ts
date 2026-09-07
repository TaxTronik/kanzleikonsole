import { computeBwaKpis } from './addison-parser';

interface CompletePlanValues {
  revenue: number;
  costs: number;
  resultBeforeTax: number;
  personnelCost: number;
  material: number;
  depreciation: number;
  otherIncome: number;
}

type PlanValues = { [K in keyof CompletePlanValues]: number | null };

export type BwaPlanBasis = { result: number | null } & (
  | (CompletePlanValues & { canApply: true; unavailableReason: null })
  | (PlanValues & { canApply: false; unavailableReason: string })
);

function complete(values: PlanValues): values is CompletePlanValues {
  return Object.values(values).every((value) => value !== null && Number.isFinite(value));
}

/**
 * BWA-IMPORT-MAPPING-001 / BWA-PROJECTION-001:
 * Nur bekannte, vollständig auf die bestehenden Planachsen übertragbare Werte
 * vorbelegen. Eine rechnerische Restgröße ist keine belegte Ertragsposition.
 */
export function computeBwaPlanBasis(
  positions: Array<{ number: number; amount: number | { toString(): string } }>,
  source: 'DATEV' | 'ADDISON' | 'MANUAL',
): BwaPlanBasis {
  if (source === 'MANUAL') {
    return {
      revenue: null,
      costs: null,
      resultBeforeTax: null,
      result: null,
      personnelCost: null,
      material: null,
      depreciation: null,
      otherIncome: null,
      canApply: false,
      unavailableReason:
        'Für manuelle BWA-Daten ist keine eindeutige Positionszuordnung hinterlegt. Bitte manuell planen.',
    };
  }
  const map = new Map(
    positions.map((position) => [position.number, Number(position.amount.toString())]),
  );
  const kpis = computeBwaKpis(positions);
  const datev = source === 'DATEV';
  const operatingIncome = map.get(1090);
  const neutralIncome = map.get(1330);
  const otherIncome = datev
    ? operatingIncome !== undefined && neutralIncome !== undefined
      ? operatingIncome + neutralIncome
      : null
    : (map.get(1010) ?? null);
  const values: PlanValues = {
    revenue: kpis.revenue,
    costs: kpis.costs,
    resultBeforeTax: kpis.resultBeforeTax,
    personnelCost: kpis.personnelCost,
    material: map.get(datev ? 1060 : 3010) ?? null,
    depreciation: map.get(datev ? 1240 : 3100) ?? null,
    otherIncome,
  };
  const unavailable = (reason: string): BwaPlanBasis => ({
    ...values,
    result: kpis.result,
    canApply: false,
    unavailableReason: reason,
  });

  // Das bestehende Planmodell hat keine eigenen Achsen für diese Posten.
  // Auch ihr Fehlen belegt nicht, dass sie tatsächlich null sind.
  if (datev && [1040, 1045, 1320].some((number) => map.get(number) !== 0)) {
    return unavailable(
      'Bestandsänderungen, Eigenleistungen oder neutraler Aufwand fehlen oder lassen sich nicht getrennt in den Planachsen abbilden. Bitte manuell planen.',
    );
  }
  if (!complete(values)) {
    return unavailable(
      'Für die automatische Vorbelegung fehlen eindeutige Umsatz-, Kosten-, Ergebnis- oder Einzelpositionen. Bitte manuell planen.',
    );
  }
  const cents = (value: number) => Math.round(value * 100);
  if (
    cents(values.revenue) + cents(values.otherIncome) - cents(values.costs) !==
    cents(values.resultBeforeTax)
  ) {
    return unavailable(
      'Die vorhandenen Planachsen ergeben nicht das ausgewiesene Ergebnis vor Steuern. Bitte Zuordnung prüfen und manuell planen.',
    );
  }
  return { ...values, result: kpis.result, canApply: true, unavailableReason: null };
}

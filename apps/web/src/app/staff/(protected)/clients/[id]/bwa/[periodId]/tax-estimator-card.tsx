'use client';

import { useState, useMemo } from 'react';
import { Calculator } from 'lucide-react';
import { estimateTaxes, type LegalForm } from '@/server/bwa/tax-estimator';

import { fmtEURRound } from '@/lib/fmt';
interface Props {
  result: number;
  /** Ergebnis vor Steuern (DATEV 1345/1300) — bevorzugte Bemessungsbasis. */
  resultBeforeTax?: number | null;
  revenue: number | null;
  inputVat: number | null;
  vatPaid: number | null;
  defaultLegalForm: LegalForm;
}

export function TaxEstimatorCard({
  result,
  resultBeforeTax,
  revenue,
  inputVat,
  vatPaid,
  defaultLegalForm,
}: Props) {
  const [legalForm, setLegalForm] = useState<LegalForm>(defaultLegalForm);
  const [hebesatz, setHebesatz] = useState<number>(400);
  const [isFreiberufler, setIsFreiberufler] = useState(false);
  const [show, setShow] = useState(false);

  // P2-12: Steuern auf das Ergebnis VOR Ertragsteuern bemessen (kein
  // Zirkelbezug). Fehlt die Zeile, Fallback auf das (evtl. Nach-Steuer-)
  // Ergebnis — der Estimator ergänzt dann einen Hinweis.
  const basis = resultBeforeTax ?? result;
  // Freiberufler-Option nur bei Nicht-Kapitalformen sinnvoll (eine GmbH ist
  // stets Gewerbebetrieb kraft Rechtsform, § 2 Abs. 2 GewStG).
  const isKapitalform = legalForm === 'GMBH' || legalForm === 'AG' || legalForm === 'UG';
  const freiberuflich = !isKapitalform && isFreiberufler;
  const est = useMemo(
    () =>
      estimateTaxes({
        legalForm,
        result: basis,
        resultIsAfterTax: resultBeforeTax == null,
        revenue,
        inputVat,
        vatPaid,
        gewerbesteuerHebesatzPct: hebesatz,
        isFreiberufler: freiberuflich,
      }),
    [legalForm, hebesatz, basis, resultBeforeTax, revenue, inputVat, vatPaid, freiberuflich],
  );


  return (
    <div className="card p-6 mb-6">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-medium text-primary">Steuerschätzung (Beta)</h2>
        </div>
        <span className="text-xs text-muted">
          {show ? 'Schließen ▴' : 'Öffnen ▾'}
        </span>
      </button>

      {show && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="legalForm">Rechtsform</label>
              <select
                id="legalForm"
                className="input"
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value as LegalForm)}
              >
                <option value="EINZELUNTERNEHMEN">Einzelunternehmen</option>
                <option value="GBR">GbR</option>
                <option value="OHG">OHG</option>
                <option value="KG">KG</option>
                <option value="GMBH">GmbH</option>
                <option value="UG">UG (haftungsbeschränkt)</option>
                <option value="AG">AG</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="hebesatz">GewSt-Hebesatz (%)</label>
              <input
                id="hebesatz"
                type="number"
                min="200"
                max="900"
                step="10"
                className="input"
                value={hebesatz}
                onChange={(e) => setHebesatz(Number(e.target.value))}
              />
            </div>
          </div>

          {!isKapitalform && (
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                checked={isFreiberufler}
                onChange={(e) => setIsFreiberufler(e.target.checked)}
              />
              Freiberufliche Tätigkeit (§ 18 EStG) — keine Gewerbesteuer
            </label>
          )}

          <div className="overflow-hidden rounded-md border border-default">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border-subtle">
                <Row label="Gewerbesteuer-Bemessung" value={fmtEURRound(est.gewerbesteuerBemessung)} muted />
                {est.gewerbesteuerFreibetrag > 0 && (
                  <Row label="abzgl. Freibetrag" value={`-${fmtEURRound(est.gewerbesteuerFreibetrag)}`} muted />
                )}
                <Row label="Gewerbesteuer" value={fmtEURRound(est.gewerbesteuer)} bold />
                {est.koerperschaftsteuer !== null && (
                  <>
                    <Row label="Körperschaftsteuer (15 %)" value={fmtEURRound(est.koerperschaftsteuer)} />
                    <Row label="Solidaritätszuschlag (5,5 %)" value={fmtEURRound(est.solidaritaetszuschlag)} />
                  </>
                )}
                {est.einkommensteuerSchaetzung !== null && (
                  <Row label="Einkommensteuer (Single, vereinfacht)" value={fmtEURRound(est.einkommensteuerSchaetzung)} />
                )}
                {est.ustZahllast !== null && (
                  <Row label="USt-Zahllast (Jahr, vereinfacht)" value={fmtEURRound(est.ustZahllast)} />
                )}
                {est.ustOffenerSaldo !== null && (
                  <Row label="… davon noch offen" value={fmtEURRound(est.ustOffenerSaldo)} muted />
                )}
                <Row label="Gesamt" value={fmtEURRound(est.gesamt)} bold highlight />
              </tbody>
            </table>
          </div>

          <ul className="text-xs text-muted space-y-1">
            {est.disclaimers.map((d, i) => (
              <li key={i}>· {d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  muted,
  bold,
  highlight,
}: {
  label: string;
  value: string;
  muted?: boolean;
  bold?: boolean;
  highlight?: boolean;
}) {
  const cls = highlight
    ? 'bg-brand-50'
    : muted
    ? 'bg-gray-50'
    : '';
  return (
    <tr className={cls}>
      <td className={`px-4 py-2 ${muted ? 'text-muted' : 'text-secondary'}`}>{label}</td>
      <td className={`px-4 py-2 text-right font-mono tabular-nums ${bold ? 'font-bold text-primary' : muted ? 'text-muted' : 'text-primary'}`}>
        {value}
      </td>
    </tr>
  );
}

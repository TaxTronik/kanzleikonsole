'use client';

import { useState, useMemo } from 'react';
import { Calculator } from 'lucide-react';
import { estimateTaxes, type LegalForm } from '@/server/bwa/tax-estimator';

interface Props {
  result: number;
  revenue: number | null;
  inputVat: number | null;
  vatPaid: number | null;
  defaultLegalForm: LegalForm;
}

export function TaxEstimatorCard({
  result,
  revenue,
  inputVat,
  vatPaid,
  defaultLegalForm,
}: Props) {
  const [legalForm, setLegalForm] = useState<LegalForm>(defaultLegalForm);
  const [hebesatz, setHebesatz] = useState<number>(400);
  const [show, setShow] = useState(false);

  const est = useMemo(
    () =>
      estimateTaxes({
        legalForm,
        result,
        revenue,
        inputVat,
        vatPaid,
        gewerbesteuerHebesatzPct: hebesatz,
      }),
    [legalForm, hebesatz, result, revenue, inputVat, vatPaid],
  );

  const fmtEUR = (n: number | null) =>
    n === null
      ? '—'
      : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);

  return (
    <div className="card p-6 mb-6">
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Calculator className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-medium text-gray-900">Steuerschätzung (Beta)</h2>
        </div>
        <span className="text-xs text-gray-500">
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

          <div className="overflow-hidden rounded-md border border-gray-200">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-100">
                <Row label="Gewerbesteuer-Bemessung" value={fmtEUR(est.gewerbesteuerBemessung)} muted />
                {est.gewerbesteuerFreibetrag > 0 && (
                  <Row label="abzgl. Freibetrag" value={`-${fmtEUR(est.gewerbesteuerFreibetrag)}`} muted />
                )}
                <Row label="Gewerbesteuer" value={fmtEUR(est.gewerbesteuer)} bold />
                {est.koerperschaftsteuer !== null && (
                  <>
                    <Row label="Körperschaftsteuer (15 %)" value={fmtEUR(est.koerperschaftsteuer)} />
                    <Row label="Solidaritätszuschlag (5,5 %)" value={fmtEUR(est.solidaritaetszuschlag)} />
                  </>
                )}
                {est.einkommensteuerSchaetzung !== null && (
                  <Row label="Einkommensteuer (Single, vereinfacht)" value={fmtEUR(est.einkommensteuerSchaetzung)} />
                )}
                {est.ustZahllast !== null && (
                  <Row label="USt-Zahllast (Jahr, vereinfacht)" value={fmtEUR(est.ustZahllast)} />
                )}
                {est.ustOffenerSaldo !== null && (
                  <Row label="… davon noch offen" value={fmtEUR(est.ustOffenerSaldo)} muted />
                )}
                <Row label="Gesamt" value={fmtEUR(est.gesamt)} bold highlight />
              </tbody>
            </table>
          </div>

          <ul className="text-xs text-gray-500 space-y-1">
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
      <td className={`px-4 py-2 ${muted ? 'text-gray-500' : 'text-gray-700'}`}>{label}</td>
      <td className={`px-4 py-2 text-right font-mono tabular-nums ${bold ? 'font-bold text-gray-900' : muted ? 'text-gray-500' : 'text-gray-900'}`}>
        {value}
      </td>
    </tr>
  );
}

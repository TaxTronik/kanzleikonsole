'use client';

import { useState, useTransition, useMemo } from 'react';
import { Save, ArrowLeft, ArrowRight, AlertCircle } from 'lucide-react';
import { fmtEURRound } from '@/lib/fmt';

export type PlanAxis =
  | 'REVENUE'
  | 'PERSONNEL'
  | 'OTHER_COSTS'
  | 'DEPRECIATION'
  | 'MATERIAL'
  | 'OTHER_INCOME'
  | 'TAXES';

export interface CreatePlanInput {
  name: string;
  year: number;
  basePeriodId: string | null;
  notes: string | null;
  status: 'DRAFT' | 'FINAL';
  lines: Array<{ axis: PlanAxis; amount: number; note: string | null }>;
}

export type CreatePlanFn = (
  input: CreatePlanInput,
) => Promise<{ ok: boolean; error?: string; id?: string }>;

interface Base {
  id: string;
  periodKey: string;
  label: string;
  periodType: 'YEAR' | 'QUARTER' | 'MONTH';
  revenue: number | null;
  costs: number | null;
  result: number | null;
  personnelCost: number | null;
  material: number | null;
  depreciation: number | null;
  otherIncome: number | null;
}

type Axis =
  | 'REVENUE'
  | 'PERSONNEL'
  | 'OTHER_COSTS'
  | 'DEPRECIATION'
  | 'MATERIAL'
  | 'OTHER_INCOME'
  | 'TAXES';

const AXIS_LABELS: Record<Axis, string> = {
  REVENUE: 'Erlöse',
  PERSONNEL: 'Personalkosten',
  OTHER_COSTS: 'Sonstige Kosten',
  DEPRECIATION: 'Abschreibungen',
  MATERIAL: 'Material-/Wareneinkauf',
  OTHER_INCOME: 'Sonstige Erträge',
  TAXES: 'Steuern (GewSt/KSt/ESt)',
};
const ALL_AXES: Axis[] = [
  'REVENUE',
  'OTHER_INCOME',
  'PERSONNEL',
  'MATERIAL',
  'DEPRECIATION',
  'OTHER_COSTS',
  'TAXES',
];
const REVENUE_AXES: Axis[] = ['REVENUE', 'OTHER_INCOME'];
const COST_AXES: Axis[] = ['PERSONNEL', 'OTHER_COSTS', 'DEPRECIATION', 'MATERIAL'];

interface LineState {
  amount: number;
  note: string;
}

function emptyLines(): Record<Axis, LineState> {
  return {
    REVENUE: { amount: 0, note: '' },
    PERSONNEL: { amount: 0, note: '' },
    OTHER_COSTS: { amount: 0, note: '' },
    DEPRECIATION: { amount: 0, note: '' },
    MATERIAL: { amount: 0, note: '' },
    OTHER_INCOME: { amount: 0, note: '' },
    TAXES: { amount: 0, note: '' },
  };
}

/**
 * Vereinfachte Steuer-Schätzung für die Planung: 30 % auf das positive
 * Ergebnis vor Steuern. Genau genug fürs Bauchgefühl, klare Annahme.
 * Bei Verlust → 0. Mandant kann den Wert frei überschreiben.
 */
function estimateTaxes(resultBeforeTax: number): number {
  if (resultBeforeTax <= 0) return 0;
  return Math.round(resultBeforeTax * 0.3);
}

export function PlanWizard({
  bases,
  defaultYear,
  onCreate,
}: {
  bases: Base[];
  defaultYear: number;
  onCreate: CreatePlanFn;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [year, setYear] = useState<number>(defaultYear);
  const [name, setName] = useState<string>(`Planung ${defaultYear}`);
  const [baseId, setBaseId] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [status, setStatus] = useState<'DRAFT' | 'FINAL'>('FINAL');
  const [lines, setLines] = useState<Record<Axis, LineState>>(emptyLines);
  const [customPct, setCustomPct] = useState<string>('');
  const [lastAppliedPct, setLastAppliedPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  const selectedBase = bases.find((b) => b.id === baseId) ?? null;

  function applyBase(percentageBump = 0) {
    if (!selectedBase) return;
    const factor = 1 + percentageBump / 100;
    const otherCosts =
      (selectedBase.costs ?? 0) -
      (selectedBase.personnelCost ?? 0) -
      (selectedBase.depreciation ?? 0) -
      (selectedBase.material ?? 0);
    const revenue = Math.round((selectedBase.revenue ?? 0) * factor);
    const personnel = Math.round((selectedBase.personnelCost ?? 0) * factor);
    const otherCost = Math.round(otherCosts * factor);
    const depr = Math.round((selectedBase.depreciation ?? 0) * factor);
    const material = Math.round((selectedBase.material ?? 0) * factor);
    const otherIncome = Math.round((selectedBase.otherIncome ?? 0) * factor);
    const resultBeforeTax = revenue + otherIncome - personnel - otherCost - depr - material;
    setLines({
      REVENUE: { amount: revenue, note: '' },
      OTHER_INCOME: { amount: otherIncome, note: '' },
      PERSONNEL: { amount: personnel, note: '' },
      OTHER_COSTS: { amount: otherCost, note: '' },
      DEPRECIATION: { amount: depr, note: '' },
      MATERIAL: { amount: material, note: '' },
      TAXES: {
        amount: estimateTaxes(resultBeforeTax),
        note: 'Schätzung ~30 % auf Ergebnis vor Steuern',
      },
    });
    setLastAppliedPct(percentageBump);
  }

  function applyCustomPct() {
    const n = Number(customPct.replace(',', '.'));
    if (!Number.isFinite(n)) return;
    applyBase(n);
  }

  const totals = useMemo(() => {
    const revenue = lines.REVENUE.amount + lines.OTHER_INCOME.amount;
    const costs =
      lines.PERSONNEL.amount +
      lines.OTHER_COSTS.amount +
      lines.DEPRECIATION.amount +
      lines.MATERIAL.amount;
    const resultBeforeTax = revenue - costs;
    const taxes = lines.TAXES.amount;
    return { revenue, costs, resultBeforeTax, taxes, resultAfterTax: resultBeforeTax - taxes };
  }, [lines]);

  function setAxis(a: Axis, patch: Partial<LineState>) {
    setLines((s) => ({ ...s, [a]: { ...s[a], ...patch } }));
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await onCreate({
        name: name.trim(),
        year,
        basePeriodId: baseId || null,
        notes: notes.trim() || null,
        status,
        lines: ALL_AXES.map((a) => ({
          axis: a,
          amount: lines[a].amount,
          note: lines[a].note.trim() || null,
        })),
      });
      if (!r.ok) setError(r.error ?? 'Fehler beim Speichern.');
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-4">
        {[1, 2, 3].map((s) => (
          <div
            key={s}
            className={'flex-1 h-1.5 rounded-full ' + (s <= step ? 'bg-brand-600' : 'bg-gray-200')}
          />
        ))}
      </div>

      {step === 1 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-medium text-primary">Schritt 1: Eckdaten</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="bwa-plan-wizard-name">
                Name der Planung
              </label>
              <input
                id="bwa-plan-wizard-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                className="input"
              />
            </div>
            <div>
              <label className="label" htmlFor="bwa-plan-wizard-year">
                Planjahr
              </label>
              <input
                id="bwa-plan-wizard-year"
                type="number"
                min={2020}
                max={2099}
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="input"
              />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="bwa-plan-wizard-base">
              Basis (aus welcher BWA übernehmen?)
            </label>
            <select
              id="bwa-plan-wizard-base"
              value={baseId}
              onChange={(e) => {
                setBaseId(e.target.value);
                setLastAppliedPct(null);
              }}
              className="input"
              aria-describedby="bwa-plan-wizard-base-hint"
            >
              <option value="">— Basis frei / leere Werte —</option>
              {bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.periodType.toLowerCase()})
                </option>
              ))}
            </select>
            {selectedBase && (
              <p id="bwa-plan-wizard-base-hint" className="text-xs text-muted mt-1">
                Erlöse {fmtEURRound(selectedBase.revenue ?? 0)} · Ergebnis{' '}
                {fmtEURRound(selectedBase.result ?? 0)}
              </p>
            )}
            {!selectedBase && (
              <p id="bwa-plan-wizard-base-hint" className="text-xs text-muted mt-1">
                Ohne Basis startest du in Schritt 2 mit Null-Werten.
              </p>
            )}
          </div>

          {selectedBase && (
            <div className="rounded-md bg-brand-50/40 border border-brand-200 p-3 space-y-3">
              <p className="text-xs text-secondary">
                Werte aus der Basis übernehmen und optional prozentual anpassen — Steuern werden
                automatisch grob geschätzt:
              </p>
              <div className="flex flex-wrap gap-1.5 items-center">
                {[-10, -5, 0, 5, 10, 20].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => applyBase(pct)}
                    className={
                      'text-xs py-1 px-2.5 rounded-md border ' +
                      (lastAppliedPct === pct
                        ? 'bg-brand-600 text-on-brand border-brand-600'
                        : 'bg-surface text-secondary border-strong hover:bg-gray-50')
                    }
                  >
                    {pct > 0 ? `+${pct} %` : pct < 0 ? `${pct} %` : 'Basis'}
                  </button>
                ))}
                <span className="text-xs text-disabled mx-1">oder</span>
                <div className="flex items-center gap-1">
                  <label className="sr-only" htmlFor="bwa-plan-wizard-percentage">
                    Prozentuale Anpassung
                  </label>
                  <input
                    id="bwa-plan-wizard-percentage"
                    type="text"
                    inputMode="decimal"
                    value={customPct}
                    onChange={(e) => setCustomPct(e.target.value)}
                    placeholder="z. B. 7,5"
                    className="input text-xs py-1 w-20 font-mono"
                  />
                  <span className="text-xs text-muted">%</span>
                  <button
                    type="button"
                    onClick={applyCustomPct}
                    disabled={!customPct.trim()}
                    className="text-xs py-1 px-2.5 rounded-md bg-surface border border-strong hover:bg-gray-50 disabled:opacity-40"
                  >
                    Anwenden
                  </button>
                </div>
              </div>

              {/* Live-Preview: was haben die Buttons gerade gemacht? */}
              {lastAppliedPct !== null && (
                <div
                  className="border-t border-brand-200 pt-2 mt-2"
                  role="status"
                  aria-live="polite"
                >
                  <p className="text-xs text-muted mb-1.5">
                    Vorbelegung übernommen
                    {lastAppliedPct !== 0
                      ? ` (${lastAppliedPct > 0 ? '+' : ''}${lastAppliedPct} %)`
                      : ''}
                    :
                  </p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <Preview label="Erlöse" v={lines.REVENUE.amount} />
                    <Preview label="Personal" v={lines.PERSONNEL.amount} />
                    <Preview label="Erg. vor St." v={totals.resultBeforeTax} accent />
                    <Preview label="Sonst. Kosten" v={lines.OTHER_COSTS.amount} />
                    <Preview label="Steuern (~30 %)" v={lines.TAXES.amount} />
                    <Preview label="Erg. nach St." v={totals.resultAfterTax} accent />
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={!name.trim() || !year}
              className="btn-primary"
            >
              Weiter
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-medium text-primary">Schritt 2: Achsen anpassen</h2>
          <p className="text-xs text-muted">
            Jahreswerte pro Position. Steuern sind grob geschätzt — bei Bedarf mit deinem
            Steuerberater präzisieren.
          </p>

          <div>
            <p className="text-xs font-medium text-secondary uppercase mb-1.5">Erträge</p>
            <div className="space-y-2">
              {REVENUE_AXES.map((a) => (
                <AxisRow key={a} axis={a} line={lines[a]} onChange={(p) => setAxis(a, p)} />
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-secondary uppercase mb-1.5">Aufwendungen</p>
            <div className="space-y-2">
              {COST_AXES.map((a) => (
                <AxisRow key={a} axis={a} line={lines[a]} onChange={(p) => setAxis(a, p)} />
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-secondary uppercase mb-1.5">Steuern</p>
            <AxisRow axis="TAXES" line={lines.TAXES} onChange={(p) => setAxis('TAXES', p)} />
            <p className="text-xs text-disabled mt-1">
              Planwert, keine Steuerberechnung: Gewerbesteuer hängt insbesondere vom kommunalen
              Hebesatz ab; Körperschaftsteuer und Solidaritätszuschlag haben eigene
              Bemessungsgrundlagen. Bitte kanzleiseitig prüfen.
            </p>
          </div>

          <div className="border-t border-default pt-3 mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Total label="Erträge" value={totals.revenue} />
            <Total label="Aufwendungen" value={totals.costs} />
            <Total label="Ergebnis vor Steuern" value={totals.resultBeforeTax} accent />
            <Total label="Ergebnis nach Steuern" value={totals.resultAfterTax} accent />
          </div>
          <div className="flex justify-between">
            <button type="button" onClick={() => setStep(1)} className="btn-secondary">
              <ArrowLeft className="h-4 w-4" />
              Zurück
            </button>
            <button type="button" onClick={() => setStep(3)} className="btn-primary">
              Weiter
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-sm font-medium text-primary">Schritt 3: Speichern</h2>
          <div>
            <label className="label" htmlFor="bwa-plan-wizard-notes">
              Anmerkungen / Annahmen (optional, Markdown)
            </label>
            <textarea
              id="bwa-plan-wizard-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              maxLength={5000}
              placeholder="z. B. Auftragslage, Preiserhöhungen, geplante Investitionen, Annahmen zu Steuern …"
              className="input text-sm"
            />
          </div>
          <fieldset>
            <legend className="label">Status</legend>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="status"
                  value="FINAL"
                  checked={status === 'FINAL'}
                  onChange={() => setStatus('FINAL')}
                  className="mt-1"
                />
                <span>
                  <strong>Final</strong> — Planung ist fertig und festgehalten. Kann später noch
                  angepasst werden, dient aber als Referenz.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="status"
                  value="DRAFT"
                  checked={status === 'DRAFT'}
                  onChange={() => setStatus('DRAFT')}
                  className="mt-1"
                />
                <span>
                  <strong>Entwurf</strong> — noch in Bearbeitung, nur als Zwischenstand gedacht.
                </span>
              </label>
            </div>
          </fieldset>
          <div className="rounded-md bg-amber-50/60 border border-amber-200 p-3 text-xs text-amber-900 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              Die Planrechnung ist ein <strong>eigener Entwurf</strong> und ersetzt keine fachliche
              Beratung. Insbesondere die Steuer­schätzung ist ein grober Pauschalwert — Ihre Kanzlei
              kann das deutlich präziser rechnen.
            </span>
          </div>
          {error && (
            <div className="alert-error-sm" role="alert">
              {error}
            </div>
          )}
          <div className="flex justify-between">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={isPending}
              className="btn-secondary"
            >
              <ArrowLeft className="h-4 w-4" />
              Zurück
            </button>
            <button type="button" onClick={submit} disabled={isPending} className="btn-primary">
              <Save className="h-4 w-4" />
              {isPending ? 'Speichert…' : 'Planung anlegen'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AxisRow({
  axis,
  line,
  onChange,
}: {
  axis: Axis;
  line: LineState;
  onChange: (patch: Partial<LineState>) => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_180px_2fr] gap-2 items-center">
      <label className="text-sm text-secondary" htmlFor={`bwa-wizard-axis-${axis}-amount`}>
        {AXIS_LABELS[axis]}
      </label>
      <div className="relative">
        <input
          id={`bwa-wizard-axis-${axis}-amount`}
          type="number"
          value={line.amount}
          onChange={(e) => onChange({ amount: Number(e.target.value) || 0 })}
          className="input pr-8 text-sm font-mono"
        />
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted"
          aria-hidden="true"
        >
          €
        </span>
      </div>
      <input
        id={`bwa-wizard-axis-${axis}-note`}
        type="text"
        value={line.note}
        onChange={(e) => onChange({ note: e.target.value })}
        maxLength={300}
        placeholder="Annahme / Notiz (optional)"
        aria-label={`Anmerkung zu ${AXIS_LABELS[axis]} (optional)`}
        className="input text-xs"
      />
    </div>
  );
}

function Preview({ label, v, accent }: { label: string; v: number; accent?: boolean }) {
  return (
    <div className="bg-surface rounded px-2 py-1 border border-default">
      <p className="text-[10px] text-muted uppercase tracking-wide">{label}</p>
      <p
        className={
          'text-xs font-mono tabular-nums ' +
          (accent && v < 0 ? 'text-red-700' : accent && v > 0 ? 'text-emerald-700' : 'text-primary')
        }
      >
        {fmtEURRound(v)}
      </p>
    </div>
  );
}

function Total({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p
        className={
          'text-lg font-bold font-mono ' +
          (accent && value < 0
            ? 'text-red-700'
            : accent && value > 0
              ? 'text-emerald-700'
              : 'text-primary')
        }
      >
        {fmtEURRound(value)}
      </p>
    </div>
  );
}

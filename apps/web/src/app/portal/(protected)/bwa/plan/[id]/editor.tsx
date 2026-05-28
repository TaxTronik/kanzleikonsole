'use client';

import { useState, useTransition, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Save, Trash2 } from 'lucide-react';

export type PlanAxis =
  | 'REVENUE' | 'PERSONNEL' | 'OTHER_COSTS' | 'DEPRECIATION' | 'MATERIAL' | 'OTHER_INCOME' | 'TAXES';

export type UpdatePlanFn = (input: {
  planId: string;
  name: string;
  notes: string | null;
  status: 'DRAFT' | 'FINAL';
  lines: Array<{ axis: PlanAxis; amount: number; note: string | null }>;
}) => Promise<{ ok: boolean; error?: string } | void>;

export type DeletePlanFn = (input: { planId: string }) => Promise<{ ok: boolean; error?: string } | void>;

type Axis =
  | 'REVENUE' | 'PERSONNEL' | 'OTHER_COSTS' | 'DEPRECIATION' | 'MATERIAL' | 'OTHER_INCOME' | 'TAXES';

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
  'REVENUE', 'OTHER_INCOME', 'PERSONNEL', 'MATERIAL', 'DEPRECIATION', 'OTHER_COSTS', 'TAXES',
];
const eurFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

interface Line {
  axis: Axis;
  amount: number;
  note: string;
}

export function PlanEditor({
  planId,
  initial,
  backHref,
  onUpdate,
  onDelete,
  actorInfo,
}: {
  planId: string;
  initial: { name: string; notes: string; status: 'DRAFT' | 'FINAL'; lines: Line[] };
  backHref: string;
  onUpdate: UpdatePlanFn;
  onDelete: DeletePlanFn;
  actorInfo?: React.ReactNode;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes);
  const [status, setStatus] = useState<'DRAFT' | 'FINAL'>(initial.status);
  const [lines, setLines] = useState<Record<Axis, Line>>(() => {
    const initialMap = new Map(initial.lines.map((l) => [l.axis, l]));
    const out = {} as Record<Axis, Line>;
    for (const a of ALL_AXES) {
      out[a] = initialMap.get(a) ?? { axis: a, amount: 0, note: '' };
    }
    return out;
  });
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isPending, start] = useTransition();

  const totals = useMemo(() => {
    const revenue = lines.REVENUE.amount + lines.OTHER_INCOME.amount;
    const costs = lines.PERSONNEL.amount + lines.OTHER_COSTS.amount + lines.DEPRECIATION.amount + lines.MATERIAL.amount;
    const resultBeforeTax = revenue - costs;
    const taxes = lines.TAXES.amount;
    return { revenue, costs, resultBeforeTax, taxes, resultAfterTax: resultBeforeTax - taxes };
  }, [lines]);

  function setAxis(a: Axis, patch: Partial<{ amount: number; note: string }>) {
    setLines((s) => ({ ...s, [a]: { ...s[a], ...patch } }));
  }

  function save() {
    setError(null);
    start(async () => {
      const r = await onUpdate({
        planId,
        name: name.trim(),
        notes: notes.trim() || null,
        status,
        lines: ALL_AXES.map((a) => ({
          axis: a,
          amount: lines[a].amount,
          note: lines[a].note.trim() || null,
        })),
      });
      if (r && r.ok === false) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      setSavedAt(Date.now());
    });
  }

  function remove() {
    if (!confirm('Planung wirklich löschen?')) return;
    start(async () => {
      const r = await onDelete({ planId });
      if (r && r.ok === false) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      router.push(backHref);
    });
  }

  return (
    <div className="space-y-4">
      {actorInfo}
      <div className="card p-6 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="input"
            />
          </div>
          <div>
            <label className="label">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'DRAFT' | 'FINAL')}
              className="input"
            >
              <option value="DRAFT">Entwurf</option>
              <option value="FINAL">Final</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">Achsen</label>
          <div className="space-y-2">
            {ALL_AXES.map((a) => (
              <div key={a} className="grid grid-cols-[1fr_180px_2fr] gap-2 items-center">
                <label className="text-sm text-secondary">{AXIS_LABELS[a]}</label>
                <div className="relative">
                  <input
                    type="number"
                    value={lines[a].amount}
                    onChange={(e) => setAxis(a, { amount: Number(e.target.value) || 0 })}
                    className="input pr-8 text-sm font-mono"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">â‚¬</span>
                </div>
                <input
                  type="text"
                  value={lines[a].note}
                  onChange={(e) => setAxis(a, { note: e.target.value })}
                  maxLength={300}
                  placeholder="Annahme / Notiz (optional)"
                  className="input text-xs"
                />
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-default pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Total label="Erträge" value={totals.revenue} />
          <Total label="Aufwendungen" value={totals.costs} />
          <Total label="Ergebnis vor Steuern" value={totals.resultBeforeTax} accent />
          <Total label="Ergebnis nach Steuern" value={totals.resultAfterTax} accent />
        </div>

        <div>
          <label className="label">Anmerkungen</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={5000}
            className="input text-sm"
          />
        </div>

        {error && <div className="alert-error-sm">{error}</div>}

        <div className="flex items-center gap-3">
          <button type="button" onClick={save} disabled={isPending} className="btn-primary">
            <Save className="h-4 w-4" />
            {isPending ? 'Speichert…' : 'Speichern'}
          </button>
          <button type="button" onClick={remove} disabled={isPending} className="text-disabled hover:text-red-700 p-2 ml-auto" title="Planung löschen">
            <Trash2 className="h-4 w-4" />
          </button>
          {savedAt && (
            <span className="text-xs text-emerald-700">
              Gespeichert {new Intl.DateTimeFormat('de-DE', { timeStyle: 'medium' }).format(new Date(savedAt))}
            </span>
          )}
        </div>
      </div>
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
          (accent && value < 0 ? 'text-red-700' : accent && value > 0 ? 'text-emerald-700' : 'text-primary')
        }
      >
        {eurFmt.format(value)}
      </p>
    </div>
  );
}

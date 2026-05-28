'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import {
  Plus, FileText, Eye, EyeOff, Trash2, Save, X, Pencil, ArrowRight,
} from 'lucide-react';
import {
  saveTaxFilingAction,
  shareTaxFilingAction,
  deleteTaxFilingAction,
} from './actions';

import { fmtEUR } from '@/lib/fmt';
const KIND_KEYS = [
  'USTA', 'UST_JAHR', 'EST', 'KST', 'GEWST_MESSBESCHEID', 'GEWST',
  'LSTA', 'FESTSTELLUNG', 'ZERLEGUNG', 'SONSTIGE',
] as const;
type Kind = typeof KIND_KEYS[number];

const KIND_LABELS: Record<Kind, string> = {
  USTA: 'USt-Voranmeldung',
  UST_JAHR: 'USt-Jahresbescheid',
  EST: 'Einkommensteuer',
  KST: 'Körperschaftsteuer',
  GEWST_MESSBESCHEID: 'GewSt-Messbescheid',
  GEWST: 'GewSt-Bescheid',
  LSTA: 'LSt-Anmeldung',
  FESTSTELLUNG: 'Feststellungsbescheid',
  ZERLEGUNG: 'Zerlegungsbescheid',
  SONSTIGE: 'Sonstige',
};

interface Filing {
  id: string;
  kind: string;
  period: string;
  filingDate: Date | null;
  expectedAssessed: number | null;
  expectedPrepaid: number | null;
  expectedRefund: number | null;
  expectedPay: number | null;
  clientNote: string | null;
  internalNote: string | null;
  sharedWithClient: boolean;
  sharedAt: Date | null;
  document: { id: string; title: string } | null;
  matchedNoticeId: string | null;
}

const dateFmt = new Intl.DateTimeFormat('de-DE');

export function FilingsSection({
  clientId,
  filings,
}: {
  clientId: string;
  filings: Filing[];
}) {
  const [editing, setEditing] = useState<Filing | null | 'NEW'>(null);
  const [isPending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  // ESLint hint — `KIND_KEYS` ist nur in der Form-Subkomponente referenziert,
  // hier oben referenzieren wir es einmal in der Sektion, falls noch nicht.
  void KIND_KEYS;

  function toggleShare(filing: Filing, share: boolean) {
    setBusyId(filing.id);
    start(async () => {
      const r = await shareTaxFilingAction({ filingId: filing.id, clientId, share });
      setBusyId(null);
      if (!r.ok) alert(r.error ?? 'Fehler.');
    });
  }

  function remove(filing: Filing) {
    if (!confirm(`Erklärung ${(KIND_LABELS[filing.kind as Kind] ?? filing.kind)} ${filing.period} wirklich löschen?`)) return;
    setBusyId(filing.id);
    start(async () => {
      const r = await deleteTaxFilingAction({ filingId: filing.id, clientId });
      setBusyId(null);
      if (!r.ok) alert(r.error ?? 'Fehler.');
    });
  }

  return (
    <div className="card overflow-hidden mb-6">
      <div className="px-5 py-3 border-b border-default flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-primary">
            Steuererklärungen / Vor-Bescheide
          </h2>
          <p className="text-xs text-muted mt-0.5">
            Was wir in DATEV/Addison übermittelt haben — optional dem Mandant vorab im Portal freigeben.
          </p>
        </div>
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing('NEW')}
            className="btn-secondary text-xs py-1"
          >
            <Plus className="h-3.5 w-3.5" />
            Erklärung erfassen
          </button>
        )}
      </div>

      {editing && (
        <FilingForm
          initial={editing === 'NEW' ? null : editing}
          clientId={clientId}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {filings.length === 0 ? (
        <p className="px-5 py-8 text-sm text-disabled text-center">
          Noch keine Erklärungen erfasst.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">Erklärung</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">Eingereicht</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">Erwartet (festges.)</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">Saldo</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted uppercase">Portal</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {filings.map((f) => {
              const saldo = f.expectedRefund ?? (f.expectedPay !== null ? -f.expectedPay : null);
              const busy = busyId === f.id && isPending;
              return (
                <tr key={f.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-primary">
                      {KIND_LABELS[f.kind as Kind] ?? f.kind}
                    </div>
                    <div className="text-xs text-muted">{f.period}</div>
                    {f.document && (
                      <Link
                        href={`/api/staff/documents/${f.document.id}/download`}
                        className="text-xs text-brand-700 hover:underline inline-flex items-center gap-1 mt-1"
                      >
                        <FileText className="h-3 w-3" />
                        Berechnung
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-secondary">
                    {f.filingDate ? dateFmt.format(f.filingDate) : '—'}
                  </td>
                  <td className="px-4 py-3 text-primary font-medium">
                    {fmtEUR(f.expectedAssessed)}
                  </td>
                  <td className={'px-4 py-3 font-medium ' + (saldo !== null && saldo < 0 ? 'text-red-700' : 'text-emerald-700')}>
                    {saldo !== null ? fmtEUR(saldo) : '—'}
                    {f.matchedNoticeId && (
                      <Link href={`/staff/clients/${clientId}/notices`} className="block text-xs text-brand-700 hover:underline mt-1 inline-flex items-center gap-1">
                        <ArrowRight className="h-3 w-3" /> Bescheid erfasst
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {f.sharedWithClient ? (
                      <button
                        type="button"
                        onClick={() => toggleShare(f, false)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
                        title={`Freigegeben am ${f.sharedAt ? dateFmt.format(f.sharedAt) : '—'}`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Sichtbar
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleShare(f, true)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary"
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                        Privat
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditing(f)}
                      disabled={busy}
                      className="text-disabled hover:text-primary p-1"
                      title="Bearbeiten"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(f)}
                      disabled={busy}
                      className="text-disabled hover:text-red-700 p-1"
                      title="Löschen"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FilingForm({
  initial,
  clientId,
  onCancel,
  onSaved,
}: {
  initial: Filing | null;
  clientId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<Kind>((initial?.kind as Kind) ?? 'EST');
  const [period, setPeriod] = useState(initial?.period ?? String(new Date().getFullYear() - 1));
  const [filingDate, setFilingDate] = useState(
    initial?.filingDate ? initial.filingDate.toISOString().slice(0, 10) : '',
  );
  const [expectedAssessed, setExpectedAssessed] = useState(numToStr(initial?.expectedAssessed));
  const [expectedPrepaid, setExpectedPrepaid] = useState(numToStr(initial?.expectedPrepaid));
  const [expectedRefund, setExpectedRefund] = useState(numToStr(initial?.expectedRefund));
  const [expectedPay, setExpectedPay] = useState(numToStr(initial?.expectedPay));
  const [clientNote, setClientNote] = useState(initial?.clientNote ?? '');
  const [internalNote, setInternalNote] = useState(initial?.internalNote ?? '');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, start] = useTransition();

  async function save() {
    setError(null);
    let pdf: { fileName: string; mimeType: string; base64: string } | null = null;
    if (pdfFile) {
      if (pdfFile.size > 10 * 1024 * 1024) {
        setError('PDF zu groß (max. 10 MB).');
        return;
      }
      try {
        pdf = {
          fileName: pdfFile.name,
          mimeType: pdfFile.type || 'application/pdf',
          base64: await fileToBase64(pdfFile),
        };
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }

    start(async () => {
      const r = await saveTaxFilingAction({
        filingId: initial?.id ?? null,
        clientId,
        kind,
        period: period.trim(),
        filingDate: filingDate || null,
        expectedAssessed: strToNum(expectedAssessed),
        expectedPrepaid: strToNum(expectedPrepaid),
        expectedRefund: strToNum(expectedRefund),
        expectedPay: strToNum(expectedPay),
        clientNote: clientNote.trim() || null,
        internalNote: internalNote.trim() || null,
        pdf,
      });
      if (!r.ok) {
        setError(r.error ?? 'Fehler beim Speichern.');
        return;
      }
      onSaved();
    });
  }

  return (
    <div className="px-5 py-4 border-b border-default bg-brand-50/30 space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="label">Steuerart</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="input"
            disabled={!!initial}
          >
            {KIND_KEYS.map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Zeitraum</label>
          <input
            type="text"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2025 oder 2025-Q3"
            maxLength={20}
            className="input"
            disabled={!!initial}
          />
        </div>
        <div>
          <label className="label">Eingereicht am</label>
          <input
            type="date"
            value={filingDate}
            onChange={(e) => setFilingDate(e.target.value)}
            className="input"
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Money label="Festgesetzte Steuer (Soll)" v={expectedAssessed} set={setExpectedAssessed} />
        <Money label="Bisherige VZ" v={expectedPrepaid} set={setExpectedPrepaid} />
        <Money label="Erwartete Erstattung" v={expectedRefund} set={setExpectedRefund} />
        <Money label="Erwartete Nachzahlung" v={expectedPay} set={setExpectedPay} />
      </div>

      <div>
        <label className="label">Hinweis an den Mandanten (im Portal sichtbar bei Freigabe)</label>
        <textarea
          value={clientNote}
          onChange={(e) => setClientNote(e.target.value)}
          rows={3}
          maxLength={5000}
          className="input text-sm"
          placeholder="z. B. „Wir haben die ESt 2024 übermittelt. Erwartete Nachzahlung ca. 3.200 €. Wir kommen wegen der Vorauszahlungen 2026 auf Sie zu."
        />
      </div>

      <div>
        <label className="label">Interne Anmerkung (nur Kanzlei)</label>
        <textarea
          value={internalNote}
          onChange={(e) => setInternalNote(e.target.value)}
          rows={2}
          maxLength={5000}
          className="input text-sm"
        />
      </div>

      <div>
        <label className="label">Berechnungs-PDF (optional, max. 10 MB)</label>
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
        {initial?.document && !pdfFile && (
          <p className="text-xs text-muted mt-1">
            Aktuell: {initial.document.title} — neue Datei wählen, um zu ersetzen.
          </p>
        )}
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      <div className="flex items-center gap-2">
        <button type="button" onClick={save} disabled={isPending} className="btn-primary">
          <Save className="h-4 w-4" />
          {isPending ? 'Speichert…' : 'Speichern'}
        </button>
        <button type="button" onClick={onCancel} disabled={isPending} className="btn-secondary">
          <X className="h-4 w-4" />
          Abbrechen
        </button>
      </div>
    </div>
  );
}

function Money({ label, v, set }: { label: string; v: string; set: (s: string) => void }) {
  return (
    <div>
      <label className="label-sm">{label}</label>
      <div className="relative">
        <input
          type="number"
          step="0.01"
          value={v}
          onChange={(e) => set(e.target.value)}
          className="input pr-8 text-sm"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">€</span>
      </div>
    </div>
  );
}

function numToStr(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n);
}
function strToNum(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

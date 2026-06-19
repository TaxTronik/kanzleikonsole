'use client';

import { useState, useTransition, useMemo, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createInvoiceFromTimeEntriesAction } from './actions';

import { fmtEUR } from '@/lib/fmt';
interface Props {
  clientId: string;
  totalHours: number;
}

export function BillingForm({ clientId, totalHours }: Props) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [subject, setSubject] = useState(`Beratungsleistungen ${new Date().toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}`);
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(inThirtyDays);
  const [vatRate, setVatRate] = useState(19);
  const [hourlyRate, setHourlyRate] = useState(120);
  const [strategy, setStrategy] = useState<'one-line' | 'per-entry'>('one-line');
  const [format, setFormat] = useState<'PDF' | 'XRECHNUNG' | 'ZUGFERD'>('XRECHNUNG');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const previewNet = useMemo(() => totalHours * hourlyRate, [totalHours, hourlyRate]);
  const previewVat = useMemo(() => (previewNet * vatRate) / 100, [previewNet, vatRate]);
  const previewGross = previewNet + previewVat;


  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await createInvoiceFromTimeEntriesAction({
        clientId,
        subject,
        issueDate,
        dueDate,
        vatRate,
        format,
        hourlyRate,
        strategy,
        notes,
      });
      if (r.error || !r.invoiceId) {
        setError(r.error ?? 'Anlegen fehlgeschlagen.');
      } else {
        router.push(`/staff/invoices/${r.invoiceId}`);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Rechnungsnummer</label>
          {/* iter85 (GoB): automatische lückenlose Vergabe beim Anlegen. */}
          <p className="input bg-gray-50 dark:bg-gray-900/40 text-muted select-none">
            wird automatisch vergeben
          </p>
        </div>
        <div>
          <label className="label" htmlFor="format">Format</label>
          <select id="format" className="input" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <option value="PDF">PDF</option>
            <option value="XRECHNUNG">XRechnung</option>
            <option value="ZUGFERD">ZUGFeRD</option>
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="subject">Betreff</label>
        <input id="subject" type="text" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={500} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="label" htmlFor="issueDate">Datum</label>
          <input id="issueDate" type="date" className="input" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="dueDate">Fällig</label>
          <input id="dueDate" type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="hourlyRate">Stundensatz</label>
          <input
            id="hourlyRate"
            type="number"
            step="0.01"
            min="0"
            className="input"
            value={hourlyRate}
            onChange={(e) => setHourlyRate(Number(e.target.value))}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="vatRate">USt %</label>
          <input
            id="vatRate"
            type="number"
            step="0.01"
            min="0"
            max="99"
            className="input"
            value={vatRate}
            onChange={(e) => setVatRate(Number(e.target.value))}
            required
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor="strategy">Positionsbildung</label>
        <select
          id="strategy"
          className="input"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value as typeof strategy)}
        >
          <option value="one-line">Eine Sammelposition (Î£ Stunden × Satz)</option>
          <option value="per-entry">Eine Position pro Time-Entry (Detail-Aufstellung)</option>
        </select>
        <p className="text-xs text-muted mt-1">
          „per-entry" liefert eine detaillierte Aufschlüsselung — empfehlenswert bei
          gemischten Tätigkeiten.
        </p>
      </div>

      <div>
        <label className="label" htmlFor="notes">Notizen (optional)</label>
        <textarea
          id="notes"
          rows={3}
          className="input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={5000}
        />
      </div>

      <div className="rounded-md bg-gray-50 p-4 grid grid-cols-2 gap-2 text-sm">
        <div className="text-right text-secondary">Netto:</div>
        <div className="font-mono tabular-nums text-right">{fmtEUR(previewNet)}</div>
        <div className="text-right text-secondary">USt ({vatRate} %):</div>
        <div className="font-mono tabular-nums text-right">{fmtEUR(previewVat)}</div>
        <div className="text-right text-primary font-bold">Brutto:</div>
        <div className="font-mono tabular-nums text-right text-primary font-bold">{fmtEUR(previewGross)}</div>
      </div>

      {error && <div className="alert-error-sm">{error}</div>}

      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Erstellt…' : 'Rechnung erstellen & Stunden verlinken'}
      </button>
    </form>
  );
}

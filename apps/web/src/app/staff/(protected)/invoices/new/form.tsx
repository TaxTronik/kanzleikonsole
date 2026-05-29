'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { createInvoiceAction } from '../actions';

import { fmtEUR } from '@/lib/fmt';
interface Position {
  description: string;
  quantity: number;
  unitPrice: number;
  unit: string;
}

interface Props {
  clients: Array<{ id: string; name: string }>;
  suggestedNumber: string;
}

export function NewInvoiceForm({ clients, suggestedNumber }: Props) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [number, setNumber] = useState(suggestedNumber);
  const [subject, setSubject] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(inThirtyDays);
  const [vatRate, setVatRate] = useState(19);
  const [format, setFormat] = useState<'PDF' | 'XRECHNUNG' | 'ZUGFERD'>('XRECHNUNG');
  const [notes, setNotes] = useState('');
  const [positions, setPositions] = useState<Position[]>([
    { description: '', quantity: 1, unitPrice: 0, unit: 'Stunde' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function setPosField<K extends keyof Position>(idx: number, key: K, value: Position[K]) {
    setPositions((ps) => ps.map((p, i) => (i === idx ? { ...p, [key]: value } : p)));
  }

  function addPosition() {
    setPositions((ps) => [...ps, { description: '', quantity: 1, unitPrice: 0, unit: 'Stunde' }]);
  }

  function removePosition(idx: number) {
    setPositions((ps) => (ps.length > 1 ? ps.filter((_, i) => i !== idx) : ps));
  }

  const netTotal = positions.reduce((s, p) => s + (p.quantity || 0) * (p.unitPrice || 0), 0);
  const vatTotal = (netTotal * vatRate) / 100;
  const grandTotal = netTotal + vatTotal;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!clientId) {
      setError('Bitte einen Mandanten wählen.');
      return;
    }
    if (positions.some((p) => !p.description.trim())) {
      setError('Bitte alle Positions-Beschreibungen ausfüllen.');
      return;
    }
    startTransition(async () => {
      const r = await createInvoiceAction({
        clientId,
        number,
        subject,
        issueDate,
        dueDate,
        vatRate,
        notes,
        format,
        positions,
      });
      if (r.error || !r.invoiceId) {
        setError(r.error ?? 'Anlegen fehlgeschlagen.');
      } else {
        router.push(`/staff/invoices/${r.invoiceId}`);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="card p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label" htmlFor="clientId">Mandant</label>
            <select
              id="clientId"
              className="input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="number">Rechnungsnummer</label>
            <input
              id="number"
              type="text"
              className="input"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              required
              maxLength={50}
            />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="subject">Betreff</label>
          <input
            id="subject"
            type="text"
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={500}
            placeholder="z. B. Buchhaltungsleistungen Q3 2025"
          />
        </div>

        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="label" htmlFor="issueDate">Rechnungsdatum</label>
            <input
              id="issueDate"
              type="date"
              className="input"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="dueDate">Fällig am</label>
            <input
              id="dueDate"
              type="date"
              className="input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="vatRate">USt (%)</label>
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
          <div>
            <label className="label" htmlFor="format">Format</label>
            <select
              id="format"
              className="input"
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
            >
              <option value="PDF">PDF</option>
              <option value="XRECHNUNG">XRechnung</option>
              <option value="ZUGFERD">ZUGFeRD</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-primary">Positionen</h3>
          <button type="button" onClick={addPosition} className="btn-secondary text-xs py-1.5">
            <Plus className="h-3.5 w-3.5" />
            Position
          </button>
        </div>

        <div className="space-y-3">
          {positions.map((p, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-5">
                <label className="label">Beschreibung</label>
                <input
                  type="text"
                  className="input"
                  value={p.description}
                  onChange={(e) => setPosField(i, 'description', e.target.value)}
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="label">Menge</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={p.quantity}
                  onChange={(e) => setPosField(i, 'quantity', Number(e.target.value))}
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="label">Einheit</label>
                <input
                  type="text"
                  className="input"
                  value={p.unit}
                  onChange={(e) => setPosField(i, 'unit', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className="label">Einzelpreis €</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={p.unitPrice}
                  onChange={(e) => setPosField(i, 'unitPrice', Number(e.target.value))}
                  required
                />
              </div>
              <div className="col-span-1 pb-2 text-right">
                <button
                  type="button"
                  onClick={() => removePosition(i)}
                  className="text-disabled hover:text-red-600 p-2"
                  disabled={positions.length === 1}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 pt-4 border-t border-default grid grid-cols-2 gap-2 text-sm">
          <div className="text-right text-secondary">Netto:</div>
          <div className="font-mono tabular-nums text-right">{fmtEUR(netTotal)}</div>
          <div className="text-right text-secondary">USt ({vatRate} %):</div>
          <div className="font-mono tabular-nums text-right">{fmtEUR(vatTotal)}</div>
          <div className="text-right text-primary font-bold">Brutto:</div>
          <div className="font-mono tabular-nums text-right text-primary font-bold">{fmtEUR(grandTotal)}</div>
        </div>
      </div>

      <div className="card p-6">
        <label className="label" htmlFor="notes">Notizen</label>
        <textarea
          id="notes"
          rows={3}
          className="input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={5000}
        />
      </div>

      {error && (
        <div className="alert-error-sm">{error}</div>
      )}

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichert…' : 'Rechnung anlegen'}
        </button>
      </div>
    </form>
  );
}


'use client';

import { useState, useTransition, type SubmitEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { createInvoiceAction } from '../actions';
import { computeVatTotals } from '@/server/invoicing/vat';

import { fmtEUR } from '@/lib/fmt';
interface Position {
  description: string;
  quantity: number;
  unitPrice: number;
  unit: string;
  // iter86: Steuersatz je Position (§ 14 Abs. 4 Nr. 8 UStG).
  vatRate: number;
}

// Stabile React-Keys für Positionszeilen (Add/Remove) — kein key={index}.
type PositionRow = Position & { id: string };
let posIdSeq = 0;
const newPosition = (): PositionRow => ({
  id: `pos-${++posIdSeq}`,
  description: '',
  quantity: 1,
  unitPrice: 0,
  unit: 'Stunde',
  vatRate: 19,
});

interface Props {
  clients: Array<{ id: string; name: string }>;
}

export function NewInvoiceForm({ clients }: Props) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [issueDate, setIssueDate] = useState(today);
  const [dueDate, setDueDate] = useState(inThirtyDays);
  const [format, setFormat] = useState<'XRECHNUNG' | 'ZUGFERD'>('XRECHNUNG');
  const [servicePeriodStart, setServicePeriodStart] = useState('');
  const [servicePeriodEnd, setServicePeriodEnd] = useState('');
  const [vatExemptionReason, setVatExemptionReason] = useState('');
  const [notes, setNotes] = useState('');
  const [positions, setPositions] = useState<PositionRow[]>([newPosition()]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function setPosField<K extends keyof Position>(idx: number, key: K, value: Position[K]) {
    setPositions((ps) => ps.map((p, i) => (i === idx ? { ...p, [key]: value } : p)));
  }

  function addPosition() {
    setPositions((ps) => [...ps, newPosition()]);
  }

  function removePosition(idx: number) {
    setPositions((ps) => (ps.length > 1 ? ps.filter((_, i) => i !== idx) : ps));
  }

  // P3-15: Vorschau mit DERSELBEN Logik wie der Server (USt je Satz-Gruppe
  // gerundet, § 14 Abs. 4 Nr. 8 UStG) statt Positions-weise — sonst weicht die
  // angezeigte Summe an Rundungsgrenzen von der tatsächlichen Rechnung ab.
  const preview = computeVatTotals(
    positions.map((p) => ({ netAmount: (p.quantity || 0) * (p.unitPrice || 0), vatRate: p.vatRate || 0 })),
  );
  const netTotal = preview.netAmount;
  const vatTotal = preview.vatAmount;
  const grandTotal = preview.totalAmount;

  function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
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
        subject,
        issueDate,
        dueDate,
        notes,
        servicePeriodStart: servicePeriodStart || undefined,
        servicePeriodEnd: servicePeriodEnd || undefined,
        vatExemptionReason: vatExemptionReason || undefined,
        format,
        // `id` ist nur der React-Key — nicht an die Action durchreichen.
        positions: positions.map((p) => ({
          description: p.description,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          unit: p.unit,
          vatRate: p.vatRate,
        })),
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
            <label className="label">Rechnungsnummer</label>
            {/* iter85 (GoB): automatische, lückenlose Vergabe beim Anlegen —
                keine manuelle Eingabe mehr (Nummernkreis je Jahr). */}
            <p className="input bg-gray-50 dark:bg-gray-900/40 text-muted select-none">
              wird automatisch vergeben (fortlaufend je Jahr)
            </p>
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
            <label className="label" htmlFor="format">Format</label>
            <select
              id="format"
              className="input"
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
            >
              <option value="XRECHNUNG">XRechnung</option>
              <option value="ZUGFERD">ZUGFeRD</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="servicePeriodStart">Leistung von (optional)</label>
            <input
              id="servicePeriodStart"
              type="date"
              className="input"
              value={servicePeriodStart}
              onChange={(e) => setServicePeriodStart(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="servicePeriodEnd">Leistung bis (optional)</label>
            <input
              id="servicePeriodEnd"
              type="date"
              className="input"
              value={servicePeriodEnd}
              onChange={(e) => setServicePeriodEnd(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted mt-2">
          Leistungszeitraum (§ 14 Abs. 4 Nr. 6 UStG) — leer lassen, wenn das Rechnungsdatum gilt.
        </p>
        {positions.some((p) => (p.vatRate || 0) === 0) && (
          <div className="mt-3">
            <label className="label" htmlFor="vatExemptionReason">Befreiungsgrund (Pflicht bei 0 %)</label>
            <input
              id="vatExemptionReason"
              type="text"
              className="input"
              maxLength={500}
              value={vatExemptionReason}
              onChange={(e) => setVatExemptionReason(e.target.value)}
              placeholder="z. B. § 19 UStG Kleinunternehmer / steuerfrei nach § 4 …"
            />
            <p className="text-xs text-muted mt-1">§ 14 Abs. 4 Nr. 8 UStG — Hinweis auf die Steuerbefreiung.</p>
          </div>
        )}
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
            <div key={p.id} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-4">
                <label className="label" htmlFor={`pos-${i}-description`}>Beschreibung</label>
                <input
                  id={`pos-${i}-description`}
                  type="text"
                  className="input"
                  value={p.description}
                  onChange={(e) => setPosField(i, 'description', e.target.value)}
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor={`pos-${i}-quantity`}>Menge</label>
                <input
                  id={`pos-${i}-quantity`}
                  type="number"
                  step="0.01"
                  className="input"
                  value={p.quantity}
                  onChange={(e) => setPosField(i, 'quantity', Number(e.target.value))}
                  required
                />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor={`pos-${i}-unit`}>Einheit</label>
                <input
                  id={`pos-${i}-unit`}
                  type="text"
                  className="input"
                  value={p.unit}
                  onChange={(e) => setPosField(i, 'unit', e.target.value)}
                />
              </div>
              <div className="col-span-2">
                <label className="label" htmlFor={`pos-${i}-unitPrice`}>Einzelpreis €</label>
                <input
                  id={`pos-${i}-unitPrice`}
                  type="number"
                  step="0.01"
                  className="input"
                  value={p.unitPrice}
                  onChange={(e) => setPosField(i, 'unitPrice', Number(e.target.value))}
                  required
                />
              </div>
              <div className="col-span-1">
                <label className="label" htmlFor={`pos-${i}-vatRate`}>USt %</label>
                <select
                  id={`pos-${i}-vatRate`}
                  className="input"
                  value={p.vatRate}
                  onChange={(e) => setPosField(i, 'vatRate', Number(e.target.value))}
                >
                  <option value={19}>19</option>
                  <option value={7}>7</option>
                  <option value={0}>0</option>
                </select>
              </div>
              <div className="col-span-1 pb-2 text-right">
                <button
                  type="button"
                  onClick={() => removePosition(i)}
                  className="text-disabled hover:text-red-600 p-2"
                  disabled={positions.length === 1}
                  aria-label="Position entfernen"
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
          <div className="text-right text-secondary">USt:</div>
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

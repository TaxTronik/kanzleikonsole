'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  STBVV_CATALOG,
  STBVV_GENERAL_RULES,
  STBVV_VERSION,
  calculateStbvv,
  type FeeLineInput,
  type FeeExpenseInput,
  type FeeCalculation,
  type FeeCalculationInput,
} from '@taxtronik/tax';
import { saveStbvvQuoteAction, createStbvvDraftAction } from './actions';
const field = 'block w-full rounded border border-default bg-surface px-3 py-2';
const euro = (c: number) =>
  (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const id = () => crypto.randomUUID();
const newLine = (): FeeLineInput => ({
  id: id(),
  feeId: '24-1-1',
  matter: '',
  rate: 1,
  rawValue: 0,
  quantity: 1,
  justification: '',
});
export function FeeCalculatorForm({
  clients,
  canSave,
}: {
  clients: Array<{ id: string; name: string }>;
  canSave: boolean;
}) {
  const [lines, setLines] = useState<FeeLineInput[]>([]);
  const [expenses, setExpenses] = useState<FeeExpenseInput[]>([]);
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [title, setTitle] = useState('Gebührenkalkulation');
  const [currentLawConfirmed, setLaw] = useState(false),
    [matterReviewConfirmed, setReview] = useState(false);
  const [vatRate, setVat] = useState<0 | 19>(19),
    [vatExemptionReason, setReason] = useState('');
  const [result, setResult] = useState<FeeCalculation | null>(null),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState(false);
  const update = (i: number, patch: Partial<FeeLineInput>) => {
    setLines((old) => old.map((l, j) => (i === j ? { ...l, ...patch } : l)));
    setResult(null);
  };
  const updateExpense = (i: number, patch: Partial<FeeExpenseInput>) => {
    setExpenses((old) => old.map((l, j) => (i === j ? { ...l, ...patch } : l)));
    setResult(null);
  };
  const input = (): FeeCalculationInput => ({
    lawVersion: STBVV_VERSION,
    currentLawConfirmed,
    matterReviewConfirmed,
    lines,
    expenses,
    vatRate,
    vatExemptionReason,
  });
  const numeric = (
    label: string,
    value: number | undefined,
    onChange: (v: number) => void,
    allowSigned = false,
  ) => (
    <label className="text-sm">
      {label}
      <input
        type="number"
        min={allowSigned ? undefined : '0'}
        step="any"
        value={value ?? ''}
        className={field}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </label>
  );
  function preview() {
    try {
      const next = calculateStbvv(input());
      setResult(next);
      setMessage('');
      return next;
    } catch (e) {
      setResult(null);
      setMessage((e as Error).message);
      return null;
    }
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label>
          Mandat
          <select className={field} value={clientId} onChange={(e) => setClientId(e.target.value)}>
            <option value="">Mandat auswählen</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Bezeichnung
          <input
            className={field}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      </div>
      {lines.map((l, i) => {
        const d = STBVV_CATALOG.find((d) => d.id === l.feeId)!;
        return (
          <fieldset key={l.id} className="rounded-lg border border-default p-4 space-y-3">
            <legend className="px-1">Position {i + 1}</legend>
            <label>
              Gebührentatbestand
              <select
                className={field}
                value={l.feeId}
                onChange={(e) => {
                  const next = STBVV_CATALOG.find((d) => d.id === e.target.value)!;
                  update(i, {
                    feeId: next.id,
                    rate: next.min,
                    consumerFirstConsultation: false,
                    creditFromLineId: undefined,
                  });
                }}
              >
                {STBVV_CATALOG.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.provision} · {d.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted">
              {d.valueHint}{' '}
              <a href={d.source} target="_blank" rel="noopener noreferrer" className="underline">
                Amtliche Vorschrift
              </a>
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              <label>
                Angelegenheit / Gegenstand / Zeitraum
                <input
                  className={field}
                  value={l.matter}
                  maxLength={160}
                  onChange={(e) => update(i, { matter: e.target.value })}
                  placeholder="z. B. Buchführung 2026"
                />
              </label>
              {d.kind === 'VALUE' &&
                numeric(
                  'Ausgangswert in Euro (vor Mindestwert / Prozentsatz)',
                  l.rawValue,
                  (v) => update(i, { rawValue: v }),
                  d.valueSign !== 'NONNEGATIVE',
                )}
              {(d.table === 'D' || d.table === 'Da') &&
                numeric('Gewichtete Betriebsfläche (ha)', l.weightedHectares, (v) =>
                  update(i, { weightedHectares: v }),
                )}
              {d.kind !== 'EXTERNAL' &&
                numeric(
                  d.kind === 'VALUE'
                    ? `Gewählter Zähler (${d.min}–${d.max}) / ${d.denominator}`
                    : `Gewählter Betrag (${d.min}–${d.max} €)`,
                  l.rate,
                  (v) => update(i, { rate: v }),
                )}
              {d.kind === 'TIME'
                ? numeric('Zusammengefasste Minuten', l.minutes, (v) => update(i, { minutes: v }))
                : d.kind === 'EXTERNAL'
                  ? numeric('Manuell ermittelter Nettobetrag (€)', l.manualAmount, (v) =>
                      update(i, { manualAmount: v }),
                    )
                  : numeric(`Anzahl (${d.unit})`, l.quantity, (v) => update(i, { quantity: v }))}
            </div>
            {d.id === '21-1' && (
              <label className="block">
                <input
                  type="checkbox"
                  checked={l.consumerFirstConsultation ?? false}
                  onChange={(e) => update(i, { consumerFirstConsultation: e.target.checked })}
                />{' '}
                Erstes Beratungsgespräch eines Verbrauchers (190-Euro-Grenze)
              </label>
            )}
            {d.id === '24-1-10' && (
              <label className="block">
                <input
                  type="checkbox"
                  checked={l.nonNaturalPerson ?? false}
                  onChange={(e) => update(i, { nonNaturalPerson: e.target.checked })}
                />{' '}
                Keine natürliche Person (Mindestwert 25.000 Euro)
              </label>
            )}
            <label>
              Beratung aus dieser Kalkulation anrechnen (§ 21 Abs. 1)
              <select
                className={field}
                value={l.creditFromLineId ?? ''}
                onChange={(e) => update(i, { creditFromLineId: e.target.value || undefined })}
              >
                <option value="">Keine Anrechnung ausgewählt</option>
                {lines
                  .filter((s) => s.feeId === '21-1' && s.id !== l.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.matter || 'Beratung'}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Wertberechnung, Rahmenwahl, Abgrenzung und Nachweis
              <textarea
                className={field}
                value={l.justification}
                minLength={10}
                maxLength={4000}
                onChange={(e) => update(i, { justification: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => {
                setLines((old) => old.filter((_, j) => j !== i));
                setResult(null);
              }}
            >
              Position entfernen
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="rounded border px-4 py-2"
        onClick={() => {
          setLines((old) => [...old, newLine()]);
          setResult(null);
        }}
      >
        Gebührenposition hinzufügen ({STBVV_CATALOG.length} Katalogeinträge)
      </button>
      {expenses.map((e, i) => (
        <fieldset key={e.id} className="rounded border p-4 space-y-3">
          <legend>Auslage {i + 1}</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              Art
              <select
                className={field}
                value={e.kind}
                onChange={(v) =>
                  updateExpense(i, { kind: v.target.value as FeeExpenseInput['kind'] })
                }
              >
                <option value="POST_PERCENT">§ 16: Postpauschale 20 %, höchstens 20 €</option>
                <option value="POST_ACTUAL">§ 16: tatsächliche Postkosten</option>
                <option value="DOCUMENTS">§ 17 / VV 7000: erstattungsfähige Papierseiten</option>
                <option value="ELECTRONIC_DOCUMENTS">
                  § 17 / VV 7000: elektronische Dateien, eine Überlassung
                </option>
                <option value="TRAVEL_KM">§ 18: Fahrtkosten 0,42 €/km</option>
                <option value="ABSENCE">§ 18: Abwesenheit je Tag</option>
                <option value="ACTUAL">Tatsächliche Auslagen / Softwarekosten mit Nachweis</option>
              </select>
            </label>
            <label>
              Angelegenheit
              <select
                className={field}
                value={e.matter}
                onChange={(v) => updateExpense(i, { matter: v.target.value })}
              >
                <option value="">Bitte wählen</option>
                {[...new Set(lines.map((l) => l.matter).filter(Boolean))].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            {['ACTUAL', 'POST_ACTUAL'].includes(e.kind) &&
              numeric('Tatsächlicher Betrag (€)', e.amount, (v) => updateExpense(i, { amount: v }))}
            {e.kind === 'DOCUMENTS' && (
              <>
                {numeric('Erstattungsfähige Schwarzweißseiten', e.pagesBw, (v) =>
                  updateExpense(i, { pagesBw: v }),
                )}
                {numeric('Erstattungsfähige Farbseiten', e.pagesColor, (v) =>
                  updateExpense(i, { pagesColor: v }),
                )}
              </>
            )}
            {e.kind === 'ELECTRONIC_DOCUMENTS' && (
              <>
                {numeric('Dateien bei dieser Überlassung', e.files, (v) =>
                  updateExpense(i, { files: v }),
                )}
                {numeric(
                  'Ggf. Scan-Mindestbetrag nach Papieräquivalent (Cent)',
                  e.scanEquivalentCents,
                  (v) => updateExpense(i, { scanEquivalentCents: v }),
                )}
              </>
            )}
            {e.kind === 'TRAVEL_KM' &&
              numeric('Gefahrene Kilometer', e.km, (v) => updateExpense(i, { km: v }))}
            {e.kind === 'ABSENCE' && (
              <>
                {numeric('Abwesenheit (Stunden, je Kalendertag)', e.hours, (v) =>
                  updateExpense(i, { hours: v }),
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={e.foreignUplift ?? false}
                    onChange={(v) => updateExpense(i, { foreignUplift: v.target.checked })}
                  />{' '}
                  Auslandsreise: Zuschlag 50 % gewählt
                </label>
              </>
            )}
          </div>
          <label>
            Anspruchsvoraussetzung / Beleg / Verteilung
            <textarea
              className={field}
              value={e.justification}
              onChange={(v) => updateExpense(i, { justification: v.target.value })}
              placeholder="Bei Dokumenten: Berechtigung nach § 17, ggf. 100-Seiten-Grenze; bei Reisen §§ 19, 20 prüfen."
            />
          </label>
          <button
            type="button"
            className="underline text-sm"
            onClick={() => {
              setExpenses((old) => old.filter((_, j) => j !== i));
              setResult(null);
            }}
          >
            Auslage entfernen
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="rounded border px-4 py-2"
        onClick={() => {
          setExpenses((old) => [
            ...old,
            { id: id(), matter: '', kind: 'POST_PERCENT', justification: '' },
          ]);
          setResult(null);
        }}
      >
        Auslage hinzufügen
      </button>
      <div className="grid md:grid-cols-2 gap-3">
        <label>
          Umsatzsteuer
          <select
            className={field}
            value={vatRate}
            onChange={(e) => {
              setVat(Number(e.target.value) as 0 | 19);
              setResult(null);
            }}
          >
            <option value={19}>19 %</option>
            <option value={0}>0 % mit Befreiungsgrund</option>
          </select>
        </label>
        {vatRate === 0 && (
          <label>
            Befreiungsgrund
            <input
              className={field}
              value={vatExemptionReason}
              onChange={(e) => {
                setReason(e.target.value);
                setResult(null);
              }}
            />
          </label>
        )}
      </div>
      <label className="block">
        <input
          type="checkbox"
          checked={currentLawConfirmed}
          onChange={(e) => {
            setLaw(e.target.checked);
            setResult(null);
          }}
        />{' '}
        Aktueller Rechtsstand {STBVV_VERSION} ist auf den Auftrag anwendbar (§ 41 geprüft).
      </label>
      <label className="block">
        <input
          type="checkbox"
          checked={matterReviewConfirmed}
          onChange={(e) => {
            setReview(e.target.checked);
            setResult(null);
          }}
        />{' '}
        Gegenstandswerte, angemessene Sätze, dieselbe Angelegenheit, Abgeltung und frühere
        Anrechnungen wurden fachlich geprüft. Diese Bestätigung ist keine Berufsträgerfreigabe im
        Fachkatalog.
      </label>
      <details>
        <summary>Allgemeine Regeln und Grenzen</summary>
        <ul className="list-disc pl-5">
          {STBVV_GENERAL_RULES.map(([p, t]) => (
            <li key={p}>
              {p}: {t}
            </li>
          ))}
        </ul>
        <p>
          §§ 21 Abs. 2 und 40 bleiben ausdrücklich dokumentierte RVG-Fremdberechnungen.
          Dokumentenpauschalen nach VV 7000 sind als enger Verweis implementiert. Historische
          Rechtsstände, Erfolgshonorare und automatische Anspruchsprüfung sind nicht enthalten.
        </p>
      </details>
      <div className="flex gap-3">
        <button type="button" className="rounded border px-4 py-2" onClick={preview}>
          Berechnen
        </button>
        <button
          type="button"
          disabled={pending || !canSave || !clientId}
          className="rounded border px-4 py-2 disabled:opacity-50"
          onClick={async () => {
            if (!preview()) return;
            setPending(true);
            try {
              const r = await saveStbvvQuoteAction(clientId, title, input());
              setMessage(
                r.ok
                  ? 'Kalkulation unveränderlich gespeichert. Im Mandat kann daraus ein Rechnungsentwurf erstellt werden.'
                  : (r.error ?? 'Speichern fehlgeschlagen.'),
              );
            } finally {
              setPending(false);
            }
          }}
        >
          Im Mandat speichern
        </button>
      </div>
      <p role="status" className="text-sm">
        {message}
      </p>
      {clientId && (
        <Link className="underline" href={`/staff/clients/${clientId}/stbvv`}>
          Gespeicherte Kalkulationen dieses Mandats
        </Link>
      )}
      {result && (
        <section className="rounded border p-4 space-y-3">
          <h2 className="font-semibold">Kalkulation · {euro(result.grossCents)} brutto</h2>
          <p>
            Netto {euro(result.netCents)} · USt {euro(result.vatCents)}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left">Position</th>
                <th className="text-right">Netto nach Anrechnung</th>
              </tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.provision} · {l.description}
                    <details>
                      <summary>Berechnung</summary>
                      {l.trace.map((t, i) => (
                        <p key={i}>{t}</p>
                      ))}
                    </details>
                  </td>
                  <td className="text-right">{euro(l.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.warnings.map((w) => (
            <p key={w} className="text-sm text-amber-800">
              {w}
            </p>
          ))}
          <button
            type="button"
            className="underline"
            onClick={() => {
              const blob = new Blob([JSON.stringify({ input: input(), result }, null, 2)], {
                  type: 'application/json',
                }),
                url = URL.createObjectURL(blob),
                a = document.createElement('a');
              a.href = url;
              a.download = 'stbvv-kalkulation.json';
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Berechnungsnachweis als JSON exportieren
          </button>
        </section>
      )}
    </div>
  );
}
export function FeeDraftForm({ clientId, quoteId }: { clientId: string; quoteId: string }) {
  const [message, setMessage] = useState(''),
    [pending, setPending] = useState(false),
    [invoiceId, setInvoiceId] = useState('');
  return (
    <form
      className="mt-3 space-y-2"
      action={async (fd) => {
        setPending(true);
        try {
          const r = await createStbvvDraftAction(
            clientId,
            quoteId,
            String(fd.get('issueDate')),
            String(fd.get('dueDate')),
          );
          if (r.ok) {
            setInvoiceId(r.invoiceId ?? '');
            setMessage('Rechnungsentwurf bereit. Es wurde nichts versandt.');
          } else setMessage(r.error ?? 'Speichern fehlgeschlagen.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex gap-3">
        <label>
          Rechnungsdatum
          <input type="date" name="issueDate" required className={field} />
        </label>
        <label>
          Fälligkeit
          <input type="date" name="dueDate" required className={field} />
        </label>
      </div>
      <button disabled={pending} className="rounded border px-3 py-2">
        Als neuen Rechnungsentwurf übernehmen
      </button>
      <p role="status">{message}</p>
      {invoiceId && (
        <Link className="underline" href={`/staff/invoices/${invoiceId}`}>
          Rechnungsentwurf öffnen
        </Link>
      )}
    </form>
  );
}
